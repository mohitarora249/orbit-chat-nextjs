import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, assertNotArchived, getConversationAccess, requireMessageAccess } from "@/lib/access";
import { cursorWhere, decodeCursor, encodeCursor, messageSelect, parseLimit, serializeMessage, syncMessageLinks } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { HttpError, jsonError, parseJson, routeError } from "@/lib/http";
import type { MessagePage } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const createMessageSchema = z.object({
  body: z.string().trim().max(4000),
  clientMessageId: z.string().min(8).max(100),
  parentId: z.string().min(1).optional(),
  attachmentIds: z.array(z.string().min(1)).max(10).default([]),
  // Forwards (shares) this message into the conversation; `body` is then an optional comment.
  forwardedMessageId: z.string().min(1).max(64).optional()
}).refine(input => input.body.length > 0 || input.attachmentIds.length > 0 || input.forwardedMessageId, "A message needs text or an attachment.");

type Context = { params: Promise<{ conversationId: string }> };

// Top-level messages, newest page first. `cursor` is the opaque `nextCursor` from the previous page and
// selects messages older than it. Deleted messages are omitted unless a thread still hangs off them.
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);

    const searchParams = request.nextUrl.searchParams;
    const limit = parseLimit(searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === null) return jsonError("limit must be an integer.", 400);
    const rawCursor = searchParams.get("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) return jsonError("Invalid cursor.", 400);

    const page = await prisma.message.findMany({
      where: {
        conversationId,
        parentId: null,
        AND: [
          { OR: [{ deletedAt: null }, { replyCount: { gt: 0 } }] },
          ...(cursor ? [cursorWhere(cursor, "before")] : [])
        ]
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: messageSelect
    });
    const items = page.slice(0, limit);
    const body: MessagePage = {
      messages: items.reverse().map(serializeMessage),
      nextCursor: page.length > limit ? encodeCursor(items[0]) : null
    };
    return NextResponse.json(body);
  } catch (error) {
    return routeError("GET messages", error, "Could not load messages.");
  }
}

const existingMessageSelect = { ...messageSelect, deletedAt: true } satisfies Prisma.MessageSelect;

function findExistingMessage(authorId: string, clientMessageId: string) {
  return prisma.message.findUnique({
    where: { authorId_clientMessageId: { authorId, clientMessageId } },
    select: existingMessageSelect
  });
}

// Idempotent replay: only return the stored message if it is the same live message in this conversation.
function replayResponse(existing: Prisma.MessageGetPayload<{ select: typeof existingMessageSelect }>, conversationId: string) {
  if (existing.conversationId !== conversationId || existing.deletedAt) {
    return jsonError("clientMessageId has already been used.", 409);
  }
  return NextResponse.json({ message: serializeMessage(existing) });
}

// The message to quote when forwarding `messageId`. Forwarding a bare forward (no comment or files of its
// own) quotes its original instead, so cards never nest.
async function resolveForward(userId: string, messageId: string, workspaceId: string) {
  const source = await requireMessageAccess(userId, messageId);
  if (source.deletedAt) throw new HttpError(409, "That message was deleted.");
  if (source.conversation.workspaceId !== workspaceId) throw new HttpError(400, "Messages can only be forwarded within their workspace.");
  const { body, forwardedFromId, _count } = await prisma.message.findUniqueOrThrow({
    where: { id: source.id },
    select: { body: true, forwardedFromId: true, _count: { select: { attachments: true } } }
  });
  if (forwardedFromId && !body && !_count.attachments) {
    const original = await prisma.message.findUnique({ where: { id: forwardedFromId }, select: { deletedAt: true } });
    if (!original || original.deletedAt) throw new HttpError(409, "The original message was deleted.");
    return forwardedFromId;
  }
  return source.id;
}

// Persists the message and its outbox event in one transaction. Live delivery is done by the outbox worker,
// so it happens even if the browser disconnects right after this request.
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const { body, clientMessageId, parentId, attachmentIds, forwardedMessageId } = await parseJson(request, createMessageSchema);

    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    await assertNotArchived(conversationId);

    const existing = await findExistingMessage(user.id, clientMessageId);
    if (existing) return replayResponse(existing, conversationId);

    let forwardedFromId: string | undefined;
    if (forwardedMessageId) {
      const { workspaceId } = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { workspaceId: true } });
      forwardedFromId = await resolveForward(user.id, forwardedMessageId, workspaceId);
    }

    try {
      const messageId = await prisma.$transaction(async tx => {
        if (parentId) {
          const parent = await tx.message.findUnique({ where: { id: parentId }, select: { conversationId: true, parentId: true, deletedAt: true } });
          if (!parent || parent.conversationId !== conversationId) throw new HttpError(404, "Thread not found.");
          if (parent.parentId) throw new HttpError(400, "Replies cannot have their own threads.");
          if (parent.deletedAt) throw new HttpError(409, "That message was deleted.");
        }
        const message = await tx.message.create({
          data: { conversationId, authorId: user.id, clientMessageId, body, parentId, forwardedFromId },
          select: { id: true, createdAt: true }
        });
        if (attachmentIds.length) {
          // Only the uploader's own, finished, not-yet-used uploads for this conversation can be attached.
          const linked = await tx.attachment.updateMany({
            where: { id: { in: attachmentIds }, uploaderId: user.id, conversationId, messageId: null, status: { in: ["SCANNING", "CLEAN"] } },
            data: { messageId: message.id }
          });
          if (linked.count !== new Set(attachmentIds).size) throw new HttpError(400, "One or more attachments are not available.");
        }
        if (parentId) {
          await tx.message.update({ where: { id: parentId }, data: { replyCount: { increment: 1 }, lastReplyAt: message.createdAt } });
        }
        await enqueue(tx, "message.created", { messageId: message.id });
        await syncMessageLinks(tx, message.id, body);
        return message.id;
      });
      notifyOutbox();
      const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: messageSelect });
      return NextResponse.json({ message: serializeMessage(message) }, { status: 201 });
    } catch (createError) {
      // A concurrent identical request won the race between our lookup and insert.
      if (createError instanceof Prisma.PrismaClientKnownRequestError && createError.code === "P2002") {
        const winner = await findExistingMessage(user.id, clientMessageId);
        if (winner) return replayResponse(winner, conversationId);
      }
      throw createError;
    }
  } catch (error) {
    return routeError("POST message", error, "Could not send message.");
  }
}
