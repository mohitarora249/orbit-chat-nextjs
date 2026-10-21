import { z } from "zod";
import { prisma } from "./prisma";
import { REMINDER_MAX_AHEAD_MS } from "./commands";
import { enqueue, notifyOutbox } from "./outbox";
import type { ChatReminder } from "./types";

// How often each server process looks for reminders that are due. Reminders go off up to this late.
const CLOCK_INTERVAL_MS = 5000;
const BATCH_SIZE = 100;
// Pending reminders one person can have at once.
export const MAX_PENDING_REMINDERS = 100;

// A reminder time sent by the browser: in the future, and within a year.
export const reminderTimeSchema = z.iso.datetime().refine(value => {
  const at = new Date(value).getTime() - Date.now();
  return at > 0 && at < REMINDER_MAX_AHEAD_MS;
}, "The time must be in the future and within a year.");

export const reminderSelect = { id: true, text: true, remindAt: true, firedAt: true, conversationId: true } as const;

export function serializeReminder(reminder: { id: string; text: string; remindAt: Date; firedAt: Date | null; conversationId: string | null }): ChatReminder {
  return { ...reminder, remindAt: reminder.remindAt.toISOString(), firedAt: reminder.firedAt?.toISOString() ?? null };
}

// All of a user's reminders that are not done, gone off or still waiting, soonest first. At most
// MAX_PENDING_REMINDERS are waiting at once, so this stays small.
export async function listReminders(userId: string) {
  const reminders = await prisma.reminder.findMany({ where: { userId }, orderBy: [{ remindAt: "asc" }, { id: "asc" }], select: reminderSelect });
  return reminders.map(serializeReminder);
}

// Marks due reminders as fired and queues their delivery in the same transaction, so each one is delivered
// through the outbox exactly as other realtime events are. SKIP LOCKED lets several server instances run this.
async function fireDueReminders() {
  const fired = await prisma.$transaction(async tx => {
    const due = await tx.$queryRaw<{ id: string; userId: string }[]>`
      UPDATE "Reminder" SET "firedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT "id" FROM "Reminder"
        WHERE "firedAt" IS NULL AND "remindAt" <= (now() AT TIME ZONE 'UTC')
        ORDER BY "remindAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "userId"`;
    for (const reminder of due) await enqueue(tx, "reminder.updated", { userId: reminder.userId, reminderId: reminder.id });
    return due.length;
  });
  if (fired) notifyOutbox();
  return fired;
}

export function startReminderClock() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while (await fireDueReminders() === BATCH_SIZE) { /* keep going until caught up */ }
    } catch (error) {
      console.error("Reminder clock failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CLOCK_INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
}
