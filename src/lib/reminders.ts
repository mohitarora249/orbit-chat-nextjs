import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";
import { REMINDER_MAX_AHEAD_MS } from "./commands";
import { visibleConversationsWhere } from "./access";
import { enqueue, notifyOutbox } from "./outbox";
import type { ChatReminder } from "./types";

// Pending reminders one person can have at once.
export const MAX_PENDING_REMINDERS = 100;

// A reminder or send time sent by the browser: in the future, and within a year.
export const futureTimeSchema = z.iso.datetime().refine(value => {
  const at = new Date(value).getTime() - Date.now();
  return at > 0 && at < REMINDER_MAX_AHEAD_MS;
}, "The time must be in the future and within a year.");

export const reminderSelect = {
  id: true,
  text: true,
  remindAt: true,
  firedAt: true,
  conversationId: true,
  message: { select: { id: true, conversationId: true, parentId: true, authorId: true, body: true, deletedAt: true } }
} satisfies Prisma.ReminderSelect;

type SelectedReminder = Prisma.ReminderGetPayload<{ select: typeof reminderSelect }>;

// The message a reminder points at is shown only while the user can still see its conversation.
export async function serializeReminders(userId: string, reminders: SelectedReminder[]): Promise<ChatReminder[]> {
  const conversationIds = [...new Set(reminders.flatMap(reminder => reminder.message ? [reminder.message.conversationId] : []))];
  const visible = new Set(conversationIds.length
    ? (await prisma.conversation.findMany({ where: { id: { in: conversationIds }, ...visibleConversationsWhere(userId) }, select: { id: true } })).map(c => c.id)
    : []);
  return reminders.map(({ message, ...reminder }) => {
    const deleted = message?.deletedAt != null;
    return {
      ...reminder,
      remindAt: reminder.remindAt.toISOString(),
      firedAt: reminder.firedAt?.toISOString() ?? null,
      message: message && visible.has(message.conversationId)
        ? { id: message.id, parentId: message.parentId, authorId: message.authorId, body: deleted ? "" : message.body, deleted }
        : null
    };
  });
}

// One of the user's reminders as it is now, or null once it is done.
export async function loadReminder(userId: string, reminderId: string) {
  const reminder = await prisma.reminder.findFirst({ where: { id: reminderId, userId }, select: reminderSelect });
  return reminder && (await serializeReminders(userId, [reminder]))[0];
}

// All of a user's reminders that are not done, gone off or still waiting, soonest first. At most
// MAX_PENDING_REMINDERS are waiting at once, so this stays small.
export async function listReminders(userId: string) {
  const reminders = await prisma.reminder.findMany({ where: { userId }, orderBy: [{ remindAt: "asc" }, { id: "asc" }], select: reminderSelect });
  return serializeReminders(userId, reminders);
}

// Queues the event that fires the reminder at `remindAt`. Call it with the transaction that sets the time.
export function scheduleReminder(tx: Prisma.TransactionClient, reminderId: string, remindAt: Date) {
  return enqueue(tx, "reminder.due", { reminderId }, remindAt);
}

// Handles `reminder.due`: fires the reminder if it is still waiting and its time has come, and queues its
// delivery in the same transaction. A reminder that was snoozed to later, already fired or marked done is
// left alone; the snooze queued its own event. Times are compared on the database clock, the same clock
// that made the event available.
export async function fireReminder(reminderId: string) {
  const fired = await prisma.$transaction(async tx => {
    const [reminder] = await tx.$queryRaw<{ userId: string }[]>`
      UPDATE "Reminder" SET "firedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = ${reminderId} AND "firedAt" IS NULL AND "remindAt" <= (now() AT TIME ZONE 'UTC')
      RETURNING "userId"`;
    if (reminder) await enqueue(tx, "reminder.updated", { userId: reminder.userId, reminderId });
    return Boolean(reminder);
  });
  if (fired) notifyOutbox();
}
