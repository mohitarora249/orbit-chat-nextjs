import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, assertNotArchived, getConversationAccess } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { notifyOutbox } from "@/lib/outbox";
import { futureTimeSchema } from "@/lib/reminders";
import { listScheduled, MAX_SCHEDULED_MESSAGES, scheduledSelect, scheduleSend, serializeScheduled } from "@/lib/scheduled";
import { HttpError, jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

// Text only: attachments, polls and forwards are sent straight away.
const createSchema = z.object({
  conversationId: z.string().min(1).max(64),
  parentId: z.string().min(1).max(64).optional(),
  body: z.string().trim().min(1, "A scheduled message needs text.").max(4000),
  sendAt: futureTimeSchema
});

// The user's scheduled messages, waiting or failed (for the Scheduled panel and reconnects).
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    return NextResponse.json({ scheduledMessages: await listScheduled(user.id) });
  } catch (error) {
    return routeError("GET /api/scheduled-messages", error, "Could not load scheduled messages.");
  }
}

// Schedules a message. The time is computed by the browser, in the user's time zone. The same checks as
// sending run now, so obvious mistakes show at once, and again when it is sent.
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId, parentId, body, sendAt } = await parseJson(request, createSchema);
    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    await assertNotArchived(conversationId);
    if (parentId) {
      const parent = await prisma.message.findUnique({ where: { id: parentId }, select: { conversationId: true, parentId: true, deletedAt: true } });
      if (!parent || parent.conversationId !== conversationId || parent.parentId) throw new HttpError(404, "Thread not found.");
      if (parent.deletedAt) throw new HttpError(409, "That message was deleted.");
    }
    const waiting = await prisma.scheduledMessage.count({ where: { authorId: user.id } });
    if (waiting >= MAX_SCHEDULED_MESSAGES) return jsonError(`You can have up to ${MAX_SCHEDULED_MESSAGES} scheduled messages.`, 400);
    const scheduled = await prisma.$transaction(async tx => {
      const created = await tx.scheduledMessage.create({
        data: { authorId: user.id, conversationId, parentId: parentId ?? null, body, sendAt: new Date(sendAt) },
        select: scheduledSelect
      });
      await scheduleSend(tx, user.id, created.id, created.sendAt);
      return created;
    });
    notifyOutbox();
    return NextResponse.json({ scheduledMessage: serializeScheduled(scheduled) }, { status: 201 });
  } catch (error) {
    return routeError("POST /api/scheduled-messages", error, "Could not schedule the message.");
  }
}
