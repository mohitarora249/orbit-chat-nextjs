import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { visibleConversationsWhere } from "./access";
import type { ConversationSummary } from "./types";

export const conversationSelect = {
  id: true,
  name: true,
  type: true,
  isPrivate: true,
  topic: true,
  members: { select: { userId: true } },
  messages: {
    where: { deletedAt: null, parentId: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { body: true, createdAt: true, author: { select: { displayName: true } } }
  }
} satisfies Prisma.ConversationSelect;

type SelectedConversation = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;
type ReadState = { unreadCount: number; mentionCount: number; lastReadAt: Date | null };

export function serializeConversation(conversation: SelectedConversation, read?: ReadState): ConversationSummary {
  const last = conversation.messages[0];
  return {
    id: conversation.id,
    name: conversation.name,
    type: conversation.type,
    isPrivate: conversation.isPrivate,
    topic: conversation.topic,
    // Public channel membership lists can be large and are not needed by the client.
    memberIds: conversation.type === "DM" || conversation.isPrivate ? conversation.members.map(member => member.userId) : [],
    unreadCount: read?.unreadCount ?? 0,
    mentionCount: read?.mentionCount ?? 0,
    lastReadAt: read?.lastReadAt?.toISOString() ?? null,
    lastMessage: last ? { body: last.body, createdAt: last.createdAt.toISOString(), author: last.author } : null
  };
}

// Unread = top-level messages from other people after the user's read cursor. Conversations the user has
// never opened count everything, capped so a long-lived channel does not make this query expensive.
// Mentions = unread top-level messages whose text contains "@<their display name>", the same rule the
// Activity feed and the client use. Thread replies are left out: the read cursor only advances to top-level
// messages, so a reply mention could never be cleared. They still reach the user live and via Activity.
const UNREAD_CAP = 100;

async function readState(userId: string, conversationIds: string[]) {
  if (!conversationIds.length) return new Map<string, ReadState>();
  const rows = await prisma.$queryRaw<{ id: string; lastReadAt: Date | null; unread: number; mentions: number }[]>`
    SELECT c.id, rc."lastReadAt",
      (SELECT count(*)::int FROM (
        SELECT 1 FROM "Message" m
        WHERE m."conversationId" = c.id AND m."parentId" IS NULL AND m."deletedAt" IS NULL
          AND m."authorId" <> ${userId}
          AND (rc."lastReadAt" IS NULL OR m."createdAt" > rc."lastReadAt")
        LIMIT ${UNREAD_CAP}
      ) unread_rows) AS unread,
      (SELECT count(*)::int FROM (
        SELECT 1 FROM "Message" m, "User" u
        WHERE u.id = ${userId} AND m."conversationId" = c.id AND m."parentId" IS NULL AND m."deletedAt" IS NULL
          AND m."authorId" <> ${userId}
          AND (rc."lastReadAt" IS NULL OR m."createdAt" > rc."lastReadAt")
          AND strpos(lower(m.body), lower('@' || u."displayName")) > 0
        LIMIT ${UNREAD_CAP}
      ) mention_rows) AS mentions
    FROM "Conversation" c
    LEFT JOIN "ReadCursor" rc ON rc."conversationId" = c.id AND rc."userId" = ${userId}
    WHERE c.id IN (${Prisma.join(conversationIds)})`;
  return new Map(rows.map(row => [row.id, { unreadCount: row.unread, mentionCount: row.mentions, lastReadAt: row.lastReadAt }]));
}

export async function listConversations(userId: string, workspaceId: string) {
  const conversations = await prisma.conversation.findMany({
    where: visibleConversationsWhere(userId, workspaceId),
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: conversationSelect
  });
  const reads = await readState(userId, conversations.map(conversation => conversation.id));
  return conversations.map(conversation => serializeConversation(conversation, reads.get(conversation.id)));
}

export async function getConversationSummary(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { ...conversationSelect, workspaceId: true } });
  return conversation ? { workspaceId: conversation.workspaceId, summary: serializeConversation(conversation) } : null;
}
