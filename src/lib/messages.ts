import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ChatMessage, ReactionSummary } from "./types";

// The public message shape. Anything sent to clients (API or socket) must go through this select.
export const messageSelect = {
  id: true,
  conversationId: true,
  authorId: true,
  clientMessageId: true,
  body: true,
  parentId: true,
  replyCount: true,
  lastReplyAt: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  author: { select: { id: true, displayName: true, avatarColor: true } },
  reactions: { select: { emoji: true, userId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  attachments: {
    select: { id: true, fileName: true, contentType: true, size: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  }
} satisfies Prisma.MessageSelect;

export type SelectedMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

function groupReactions(reactions: SelectedMessage["reactions"]): ReactionSummary[] {
  const byEmoji = new Map<string, string[]>();
  for (const { emoji, userId } of reactions) byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), userId]);
  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, userIds }));
}

// Deleted messages are kept as tombstones (so threads and reconnect sync stay consistent) but carry no content.
export function serializeMessage(message: SelectedMessage): ChatMessage {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    conversationId: message.conversationId,
    authorId: message.authorId,
    clientMessageId: message.clientMessageId,
    body: deleted ? "" : message.body,
    parentId: message.parentId,
    replyCount: message.replyCount,
    lastReplyAt: message.lastReplyAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    author: message.author,
    reactions: deleted ? [] : groupReactions(message.reactions),
    attachments: deleted ? [] : message.attachments
  };
}

// Opaque pagination cursor: clients pass it back verbatim and must not parse it.
const cursorSchema = z.object({ t: z.iso.datetime(), id: z.string().min(1).max(64) });
export type MessageCursor = { createdAt: Date; id: string };

export function encodeCursor(message: { createdAt: Date | string; id: string }) {
  const t = typeof message.createdAt === "string" ? message.createdAt : message.createdAt.toISOString();
  return Buffer.from(JSON.stringify({ t, id: message.id })).toString("base64url");
}

export function decodeCursor(value: string): MessageCursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? { createdAt: new Date(parsed.data.t), id: parsed.data.id } : null;
  } catch {
    return null;
  }
}

// Keyset filter for messages strictly before / after the cursor in (createdAt, id) order.
export function cursorWhere(cursor: MessageCursor, direction: "before" | "after"): Prisma.MessageWhereInput {
  const op = direction === "before" ? "lt" : "gt";
  return { OR: [{ createdAt: { [op]: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { [op]: cursor.id } }] };
}

export function parseLimit(raw: string | null, fallback: number, max: number) {
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(value)) return null;
  return Math.min(Math.max(value, 1), max);
}
