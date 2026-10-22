import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { futureTimeSchema, loadReminder, scheduleReminder } from "@/lib/reminders";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ reminderId: string }> };

const snoozeSchema = z.object({ remindAt: futureTimeSchema });

// Snoozes a reminder: it goes off again at `remindAt`. The event queued for the old time finds it not yet
// due (or already fired) and does nothing.
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { reminderId } = await context.params;
    const { remindAt } = await parseJson(request, snoozeSchema);
    const found = await prisma.$transaction(async tx => {
      const updated = await tx.reminder.updateMany({ where: { id: reminderId, userId: user.id }, data: { remindAt: new Date(remindAt), firedAt: null } });
      if (!updated.count) return false;
      await enqueue(tx, "reminder.updated", { userId: user.id, reminderId });
      await scheduleReminder(tx, reminderId, new Date(remindAt));
      return true;
    });
    if (!found) return jsonError("Reminder not found.", 404);
    notifyOutbox();
    return NextResponse.json({ reminder: await loadReminder(user.id, reminderId) });
  } catch (error) {
    return routeError("PATCH reminder", error, "Could not snooze the reminder.");
  }
}

// Marks a reminder as done, which deletes it. Done twice is fine.
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { reminderId } = await context.params;
    await prisma.$transaction(async tx => {
      const removed = await tx.reminder.deleteMany({ where: { id: reminderId, userId: user.id } });
      if (removed.count) await enqueue(tx, "reminder.updated", { userId: user.id, reminderId });
    });
    notifyOutbox();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError("DELETE reminder", error, "Could not update the reminder.");
  }
}
