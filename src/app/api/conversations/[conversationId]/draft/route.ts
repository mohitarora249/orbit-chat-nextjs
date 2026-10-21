import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, getConversationAccess } from "@/lib/access";
import { serializeDraft } from "@/lib/conversations";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ conversationId: string }> };

// Messages allow 4000 characters as typed; <@id> tokens can be longer than the names they replace.
const draftSchema = z.object({ body: z.string().max(8000) });

// Saves the unsent text of the user's composer in a conversation. Blank text deletes the draft.
// Responds with the saved draft, or null.
export async function PUT(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const { body } = await parseJson(request, draftSchema);
    const key = { userId_conversationId: { userId: user.id, conversationId } };
    if (!body.trim()) {
      // Clearing needs no access check: it only removes the user's own draft.
      await prisma.$transaction(async tx => {
        const removed = await tx.draft.deleteMany({ where: { userId: user.id, conversationId } });
        if (removed.count) await enqueue(tx, "conversation.draft", { userId: user.id, conversationId });
      });
      notifyOutbox();
      return NextResponse.json({ draft: null });
    }
    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    const draft = await prisma.$transaction(async tx => {
      const saved = await tx.draft.upsert({ where: key, create: { userId: user.id, conversationId, body }, update: { body }, select: { body: true, updatedAt: true } });
      await enqueue(tx, "conversation.draft", { userId: user.id, conversationId });
      return saved;
    });
    notifyOutbox();
    return NextResponse.json({ draft: serializeDraft(draft) });
  } catch (error) {
    return routeError("PUT conversation draft", error, "Could not save draft.");
  }
}
