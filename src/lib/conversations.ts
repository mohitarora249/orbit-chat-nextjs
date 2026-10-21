import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { visibleConversationsWhere } from "./access";
import { broadcastToken, userToken } from "./mentions";
import type { ConversationSummary, Draft } from "./types";

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

export function serializeConversation(conversation: SelectedConversation, read?: ReadState, readCursors?: Record<string, string>): ConversationSummary {
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
    readCursors: conversation.type === "DM" ? readCursors ?? {} : {},
    lastMessage: last ? { body: last.body, createdAt: last.createdAt.toISOString(), author: last.author } : null
  };
}

// Unread = top-level messages from other people after the user's read cursor. Conversations the user has
// never opened count everything, capped so a long-lived channel does not make this query expensive.
// Mentions = unread top-level messages containing the user's <@id> token or <!channel>, the same rule as the
// Activity feed (see src/lib/mentions.ts; @here only alerts live). Thread replies are left out: the read cursor only advances to top-level
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
        SELECT 1 FROM "Message" m
        WHERE m."conversationId" = c.id AND m."parentId" IS NULL AND m."deletedAt" IS NULL
          AND m."authorId" <> ${userId}
          AND (rc."lastReadAt" IS NULL OR m."createdAt" > rc."lastReadAt")
          AND (strpos(m.body, ${userToken(userId)}) > 0 OR strpos(m.body, ${broadcastToken("channel")}) > 0)
        LIMIT ${UNREAD_CAP}
      ) mention_rows) AS mentions
    FROM "Conversation" c
    LEFT JOIN "ReadCursor" rc ON rc."conversationId" = c.id AND rc."userId" = ${userId}
    WHERE c.id IN (${Prisma.join(conversationIds)})`;
  return new Map(rows.map(row => [row.id, { unreadCount: row.unread, mentionCount: row.mentions, lastReadAt: row.lastReadAt }]));
}

// Every member's read cursor in the given DMs, for "Seen" receipts. Channels never expose other people's cursors.
async function dmReadCursors(conversationIds: string[]) {
  const cursors = new Map<string, Record<string, string>>();
  if (!conversationIds.length) return cursors;
  const rows = await prisma.readCursor.findMany({
    where: { conversationId: { in: conversationIds }, conversation: { type: "DM" } },
    select: { conversationId: true, userId: true, lastReadAt: true }
  });
  for (const row of rows) cursors.set(row.conversationId, { ...cursors.get(row.conversationId), [row.userId]: row.lastReadAt.toISOString() });
  return cursors;
}

export async function listConversations(userId: string, workspaceId: string) {
  const conversations = await prisma.conversation.findMany({
    where: visibleConversationsWhere(userId, workspaceId),
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: conversationSelect
  });
  const ids = conversations.map(conversation => conversation.id);
  const [reads, cursors] = await Promise.all([readState(userId, ids), dmReadCursors(ids.filter((_, index) => conversations[index].type === "DM"))]);
  return conversations.map(conversation => serializeConversation(conversation, reads.get(conversation.id), cursors.get(conversation.id)));
}

export async function getConversationSummary(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { ...conversationSelect, workspaceId: true } });
  return conversation ? { workspaceId: conversation.workspaceId, summary: serializeConversation(conversation) } : null;
}

// The user's pinned conversations, oldest pin first (the sidebar order). Pins of conversations the user can
// no longer see are skipped, not deleted, so they come back if access does.
export async function listPinnedConversationIds(userId: string, workspaceId?: string) {
  const pins = await prisma.pinnedConversation.findMany({
    where: { userId, conversation: visibleConversationsWhere(userId, workspaceId) },
    orderBy: [{ createdAt: "asc" }, { conversationId: "asc" }],
    select: { conversationId: true }
  });
  return pins.map(pin => pin.conversationId);
}

// The user's drafts, by conversation id. Like pins, drafts in conversations the user can no longer see are
// skipped, not deleted.
export async function listDrafts(userId: string, workspaceId?: string) {
  const drafts = await prisma.draft.findMany({
    where: { userId, conversation: visibleConversationsWhere(userId, workspaceId) },
    select: { conversationId: true, body: true, updatedAt: true }
  });
  return Object.fromEntries(drafts.map(draft => [draft.conversationId, serializeDraft(draft)])) as Record<string, Draft>;
}

export function serializeDraft(draft: { body: string; updatedAt: Date }): Draft {
  return { body: draft.body, updatedAt: draft.updatedAt.toISOString() };
}
