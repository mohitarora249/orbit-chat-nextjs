import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { ARCHIVED_ERROR, getConversationAccess } from "./access";
import { HttpError } from "./errors";
import { insertMessage } from "./messages";
import { enqueue, notifyOutbox } from "./outbox";
import type { ChatScheduledMessage } from "./types";

// Scheduled messages one person can have waiting at once.
export const MAX_SCHEDULED_MESSAGES = 100;

export const scheduledSelect = { id: true, conversationId: true, parentId: true, body: true, sendAt: true, failedAt: true, failReason: true } satisfies Prisma.ScheduledMessageSelect;

type SelectedScheduled = Prisma.ScheduledMessageGetPayload<{ select: typeof scheduledSelect }>;

export function serializeScheduled(scheduled: SelectedScheduled): ChatScheduledMessage {
  return { ...scheduled, sendAt: scheduled.sendAt.toISOString(), failedAt: scheduled.failedAt?.toISOString() ?? null };
}

// The user's scheduled messages, waiting or failed, soonest first.
export async function listScheduled(userId: string) {
  const scheduled = await prisma.scheduledMessage.findMany({ where: { authorId: userId }, orderBy: [{ sendAt: "asc" }, { id: "asc" }], select: scheduledSelect });
  return scheduled.map(serializeScheduled);
}

// Queues the event that sends the message at `sendAt`, and tells the author's tabs about the change. Call it
// with the transaction that sets the time; events queued for earlier times find it not yet due and do nothing.
export async function scheduleSend(tx: Prisma.TransactionClient, userId: string, scheduledMessageId: string, sendAt: Date) {
  await enqueue(tx, "scheduled.updated", { userId, scheduledMessageId });
  await enqueue(tx, "message.scheduled", { scheduledMessageId }, sendAt);
}

// The message the author sees when the send fails for a reason that waiting will not fix.
async function sendBlocker(tx: Prisma.TransactionClient, scheduled: { authorId: string; conversationId: string }) {
  if (await getConversationAccess(scheduled.authorId, scheduled.conversationId) !== "ok") return "You can no longer post in this conversation.";
  const conversation = await tx.conversation.findUnique({ where: { id: scheduled.conversationId }, select: { archivedAt: true } });
  return conversation?.archivedAt ? ARCHIVED_ERROR : null;
}

// Handles `message.scheduled`: if the message is still waiting and due, posts it as an ordinary message, in
// the same transaction that deletes it, so it is sent exactly once. The row is locked first, so an edit or
// delete from its author either lands before the send or finds it gone. A message that can no longer be sent
// is marked failed instead. Database errors are thrown, so the outbox retries.
export async function sendScheduledMessage(scheduledMessageId: string) {
  const changed = await prisma.$transaction(async tx => {
    const [scheduled] = await tx.$queryRaw<{ authorId: string; conversationId: string; parentId: string | null; body: string }[]>`
      SELECT "authorId", "conversationId", "parentId", "body" FROM "ScheduledMessage"
      WHERE "id" = ${scheduledMessageId} AND "failedAt" IS NULL AND "sendAt" <= (now() AT TIME ZONE 'UTC')
      FOR UPDATE`;
    if (!scheduled) return false;
    const fail = async (reason: string) => {
      await tx.scheduledMessage.update({ where: { id: scheduledMessageId }, data: { failedAt: new Date(), failReason: reason } });
      await enqueue(tx, "scheduled.updated", { userId: scheduled.authorId, scheduledMessageId });
      return true;
    };
    const blocker = await sendBlocker(tx, scheduled);
    if (blocker) return fail(blocker);
    try {
      // Its own id makes the clientMessageId unique for the author.
      await insertMessage(tx, { ...scheduled, clientMessageId: `scheduled:${scheduledMessageId}` });
    } catch (error) {
      // The thread it replies to was deleted, or is otherwise gone.
      if (error instanceof HttpError) return fail(error.message);
      throw error;
    }
    await tx.scheduledMessage.delete({ where: { id: scheduledMessageId } });
    await enqueue(tx, "scheduled.updated", { userId: scheduled.authorId, scheduledMessageId });
    return true;
  });
  if (changed) notifyOutbox();
}

// When the outbox gives up on sending (repeated database errors), the author is told rather than left waiting.
export async function markScheduledFailed(scheduledMessageId: string) {
  const changed = await prisma.$transaction(async tx => {
    const scheduled = await tx.scheduledMessage.findUnique({ where: { id: scheduledMessageId }, select: { authorId: true, failedAt: true } });
    if (!scheduled || scheduled.failedAt) return false;
    await tx.scheduledMessage.update({ where: { id: scheduledMessageId }, data: { failedAt: new Date(), failReason: "Something went wrong while sending it." } });
    await enqueue(tx, "scheduled.updated", { userId: scheduled.authorId, scheduledMessageId });
    return true;
  });
  if (changed) notifyOutbox();
}
