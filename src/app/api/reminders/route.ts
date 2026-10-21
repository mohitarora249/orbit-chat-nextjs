import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, getConversationAccess } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { REMINDER_TEXT_MAX } from "@/lib/commands";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { listReminders, MAX_PENDING_REMINDERS, reminderSelect, reminderTimeSchema, serializeReminder } from "@/lib/reminders";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  text: z.string().trim().min(1, "Add what to remind you about.").max(REMINDER_TEXT_MAX),
  remindAt: reminderTimeSchema,
  conversationId: z.string().min(1).max(64).optional()
});

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
    const { text, remindAt, conversationId } = await parseJson(request, createSchema);
    if (conversationId) {
      const access = await getConversationAccess(user.id, conversationId);
      if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    }
    const pending = await prisma.reminder.count({ where: { userId: user.id, firedAt: null } });
    if (pending >= MAX_PENDING_REMINDERS) return jsonError(`You can have up to ${MAX_PENDING_REMINDERS} reminders waiting.`, 400);
    // Announced so the user's other tabs list it too.
    const reminder = await prisma.$transaction(async tx => {
      const created = await tx.reminder.create({
        data: { userId: user.id, text, remindAt: new Date(remindAt), conversationId: conversationId ?? null },
        select: reminderSelect
      });
      await enqueue(tx, "reminder.updated", { userId: user.id, reminderId: created.id });
      return created;
    });
    notifyOutbox();
    return NextResponse.json({ reminder: serializeReminder(reminder) });
  } catch (error) {
    return routeError("POST /api/reminders", error, "Could not set the reminder.");
  }
}
