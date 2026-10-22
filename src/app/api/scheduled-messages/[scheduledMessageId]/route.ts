import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { futureTimeSchema } from "@/lib/reminders";
import { scheduledSelect, scheduleSend, serializeScheduled } from "@/lib/scheduled";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ scheduledMessageId: string }> };

const updateSchema = z.object({
  body: z.string().trim().min(1, "A scheduled message needs text.").max(4000).optional(),
  // A new send time, or `sendNow` to send it straight away. Either one also retries a failed message.
  sendAt: futureTimeSchema.optional(),
  sendNow: z.literal(true).optional()
}).refine(input => !(input.sendAt && input.sendNow), "Choose a time or send now, not both.")
  .refine(input => input.body !== undefined || input.sendAt || input.sendNow, "Nothing to change.");

const ALREADY_SENT = "This message was already sent.";

// Edits, reschedules or sends now. The send locks the row, so this either lands before the send or finds it
// gone. Events queued for the old time find it not yet due and do nothing.
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { scheduledMessageId } = await context.params;
    const { body, sendAt, sendNow } = await parseJson(request, updateSchema);
    const when = sendNow ? new Date() : sendAt ? new Date(sendAt) : null;
    const scheduled = await prisma.$transaction(async tx => {
      const updated = await tx.scheduledMessage.updateMany({
        where: { id: scheduledMessageId, authorId: user.id },
        data: { ...(body !== undefined && { body }), ...(when && { sendAt: when, failedAt: null, failReason: null }) }
      });
      if (!updated.count) return null;
      if (when) await scheduleSend(tx, user.id, scheduledMessageId, when);
      else await enqueue(tx, "scheduled.updated", { userId: user.id, scheduledMessageId });
      return tx.scheduledMessage.findUniqueOrThrow({ where: { id: scheduledMessageId }, select: scheduledSelect });
    });
    if (!scheduled) return jsonError(ALREADY_SENT, 404);
    notifyOutbox();
    return NextResponse.json({ scheduledMessage: serializeScheduled(scheduled) });
  } catch (error) {
    return routeError("PATCH scheduled message", error, "Could not update the scheduled message.");
  }
}

// Deletes a scheduled message so it is never sent. `deleted` is false if it was already sent (or deleted).
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { scheduledMessageId } = await context.params;
    const deleted = await prisma.$transaction(async tx => {
      const removed = await tx.scheduledMessage.deleteMany({ where: { id: scheduledMessageId, authorId: user.id } });
      if (removed.count) await enqueue(tx, "scheduled.updated", { userId: user.id, scheduledMessageId });
      return removed.count > 0;
    });
    if (deleted) notifyOutbox();
    return NextResponse.json({ deleted });
  } catch (error) {
    return routeError("DELETE scheduled message", error, "Could not delete the scheduled message.");
  }
}
