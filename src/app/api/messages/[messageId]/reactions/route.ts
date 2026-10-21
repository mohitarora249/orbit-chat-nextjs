import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMessageAccess } from "@/lib/access";
import { messageSelect, serializeMessage } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ messageId: string }> };

const MAX_DISTINCT_EMOJI = 50;

// A single emoji, including skin tones, ZWJ sequences, keycaps and flags.
const reactionSchema = z.object({
  emoji: z.string().min(1).max(32).regex(/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\u20e3)+$/u, "Reactions must be an emoji.")
});

async function changeReaction(request: NextRequest, context: Context, op: "add" | "remove") {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { messageId } = await context.params;
  const { emoji } = await parseJson(request, reactionSchema);
  const message = await requireMessageAccess(user.id, messageId);
  if (message.deletedAt) return jsonError("Message not found.", 404);

  if (op === "add") {
    const distinct = await prisma.reaction.groupBy({ by: ["emoji"], where: { messageId } });
    if (distinct.length >= MAX_DISTINCT_EMOJI && !distinct.some(row => row.emoji === emoji)) {
      return jsonError("This message has too many different reactions.", 400);
    }
  }
  const updated = await prisma.$transaction(async tx => {
    const changed = op === "add"
      ? await tx.reaction.createMany({ data: [{ messageId, userId: user.id, emoji }], skipDuplicates: true })
      : await tx.reaction.deleteMany({ where: { messageId, userId: user.id, emoji } });
    if (changed.count) await enqueue(tx, "message.updated", { messageId });
    return tx.message.findUniqueOrThrow({ where: { id: messageId }, select: messageSelect });
  });
  notifyOutbox();
  return NextResponse.json({ message: serializeMessage(updated) });
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    return await changeReaction(request, context, "add");
  } catch (error) {
    return routeError("PUT reaction", error, "Could not add reaction.");
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    return await changeReaction(request, context, "remove");
  } catch (error) {
    return routeError("DELETE reaction", error, "Could not remove reaction.");
  }
}
