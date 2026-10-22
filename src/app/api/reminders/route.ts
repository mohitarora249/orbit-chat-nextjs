import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, getConversationAccess, requireMessageAccess } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { REMINDER_TEXT_MAX } from "@/lib/commands";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { futureTimeSchema, listReminders, loadReminder, MAX_PENDING_REMINDERS, scheduleReminder } from "@/lib/reminders";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  text: z.string().trim().max(REMINDER_TEXT_MAX).default(""),
  remindAt: futureTimeSchema,
  conversationId: z.string().min(1).max(64).optional(),
  // "Remind me about this message". The conversation is then the message's own.
  messageId: z.string().min(1).max(64).optional()
}).refine(input => input.text.length > 0 || input.messageId, "Add what to remind you about.");

// The user's reminders that are not done, gone off or waiting (for the Reminders panel and reconnects).
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    return NextResponse.json({ reminders: await listReminders(user.id) });
  } catch (error) {
    return routeError("GET /api/reminders", error, "Could not load reminders.");
  }
}

// Sets a reminder for the signed-in user. The time is computed by the browser, in the user's time zone.
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { text, remindAt, messageId, ...input } = await parseJson(request, createSchema);
    let conversationId = input.conversationId;
    if (messageId) {
      const message = await requireMessageAccess(user.id, messageId);
      if (message.deletedAt) return jsonError("That message was deleted.", 409);
      conversationId = message.conversationId;
    } else if (conversationId) {
      const access = await getConversationAccess(user.id, conversationId);
      if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    }
    const pending = await prisma.reminder.count({ where: { userId: user.id, firedAt: null } });
    if (pending >= MAX_PENDING_REMINDERS) return jsonError(`You can have up to ${MAX_PENDING_REMINDERS} reminders waiting.`, 400);
    // Announced so the user's other tabs list it too, and fired by the outbox worker when it is due.
    const reminderId = await prisma.$transaction(async tx => {
      const created = await tx.reminder.create({
        data: { userId: user.id, text, remindAt: new Date(remindAt), conversationId: conversationId ?? null, messageId: messageId ?? null },
        select: { id: true, remindAt: true }
      });
      await enqueue(tx, "reminder.updated", { userId: user.id, reminderId: created.id });
      await scheduleReminder(tx, created.id, created.remindAt);
      return created.id;
    });
    notifyOutbox();
    return NextResponse.json({ reminder: await loadReminder(user.id, reminderId) });
  } catch (error) {
    return routeError("POST /api/reminders", error, "Could not set the reminder.");
  }
}
