import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, getConversationAccess } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const markReadSchema = z.object({ messageId: z.string().min(1) });

type Context = { params: Promise<{ conversationId: string }> };

// Moves the read cursor up to the given message. It never moves backwards, so out-of-order requests
// from several tabs are harmless.
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const { messageId } = await parseJson(request, markReadSchema);
    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);

    const message = await prisma.message.findFirst({ where: { id: messageId, conversationId }, select: { id: true } });
    if (!message) return jsonError("Message not found.", 404);

    const lastReadAt = await prisma.$transaction(async tx => {
      // The timestamp is copied in SQL so it compares exactly with "Message"."createdAt".
      const [cursor] = await tx.$queryRaw<{ lastReadAt: Date }[]>`
        INSERT INTO "ReadCursor" ("id", "conversationId", "userId", "lastReadAt")
        SELECT ${crypto.randomUUID()}, ${conversationId}, ${user.id}, "createdAt" FROM "Message" WHERE "id" = ${message.id}
        ON CONFLICT ("conversationId", "userId")
        DO UPDATE SET "lastReadAt" = GREATEST("ReadCursor"."lastReadAt", EXCLUDED."lastReadAt")
        RETURNING "lastReadAt"`;
      await enqueue(tx, "conversation.read", { conversationId, userId: user.id, lastReadAt: cursor.lastReadAt.toISOString() });
      return cursor.lastReadAt;
    });
    notifyOutbox();
    return NextResponse.json({ lastReadAt: lastReadAt.toISOString() });
  } catch (error) {
    return routeError("POST read", error, "Could not update read state.");
  }
}
