import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { accessErrors, getConversationAccess } from "@/lib/access";
import { listPinnedConversationIds } from "@/lib/conversations";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ conversationId: string }> };

const MAX_PINNED_CONVERSATIONS = 50;

// Pins a channel or DM to the top of the user's own sidebar. Responds with the full pinned list in order.
export async function PUT(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    const count = await prisma.pinnedConversation.count({ where: { userId: user.id } });
    if (count >= MAX_PINNED_CONVERSATIONS && !(await prisma.pinnedConversation.findUnique({ where: { userId_conversationId: { userId: user.id, conversationId } }, select: { userId: true } }))) {
      return jsonError(`You can pin at most ${MAX_PINNED_CONVERSATIONS} conversations. Unpin one first.`, 400);
    }
    await prisma.$transaction(async tx => {
      const created = await tx.pinnedConversation.createMany({ data: [{ userId: user.id, conversationId }], skipDuplicates: true });
      if (created.count) await enqueue(tx, "conversation.pins", { userId: user.id });
    });
    notifyOutbox();
    return NextResponse.json({ pinnedConversationIds: await listPinnedConversationIds(user.id) });
  } catch (error) {
    return routeError("PUT conversation pin", error, "Could not pin conversation.");
  }
}

// Unpinning needs no access check: it only removes the user's own pin.
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    await prisma.$transaction(async tx => {
      const removed = await tx.pinnedConversation.deleteMany({ where: { userId: user.id, conversationId } });
      if (removed.count) await enqueue(tx, "conversation.pins", { userId: user.id });
    });
    notifyOutbox();
    return NextResponse.json({ pinnedConversationIds: await listPinnedConversationIds(user.id) });
  } catch (error) {
    return routeError("DELETE conversation pin", error, "Could not unpin conversation.");
  }
}
