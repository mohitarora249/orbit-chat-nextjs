import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { extractLinks } from "./links";
import { enqueue } from "./outbox";
import type { ChatForward, ChatLinkPreview, ChatMessage, ChatPoll, ReactionSummary } from "./types";

const attachmentSelect = {
  select: { id: true, fileName: true, contentType: true, size: true, status: true },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }]
} satisfies Prisma.Message$attachmentsArgs;

const pollSelect = {
  select: {
    id: true,
    multiSelect: true,
    anonymous: true,
    closesAt: true,
    closedAt: true,
    options: {
      select: { id: true, label: true, votes: { select: { userId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
      orderBy: { position: "asc" }
    }
  }
} satisfies Prisma.Message$pollArgs;

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
  attachments: attachmentSelect,
  poll: pollSelect,
  links: {
    select: { url: true, preview: { select: { status: true, title: true, description: true, siteName: true, imageUrl: true } } },
    orderBy: { position: "asc" }
  },
  forwardedFrom: {
    select: {
      id: true,
      conversationId: true,
      parentId: true,
      body: true,
      createdAt: true,
      editedAt: true,
      deletedAt: true,
      conversation: { select: { type: true, isPrivate: true, name: true } },
      author: { select: { id: true, displayName: true, avatarColor: true } },
      attachments: attachmentSelect,
      poll: pollSelect
    }
  }
} satisfies Prisma.MessageSelect;

export type SelectedMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

function groupReactions(reactions: SelectedMessage["reactions"]): ReactionSummary[] {
  const byEmoji = new Map<string, string[]>();
  for (const { emoji, userId } of reactions) byEmoji.set(emoji, [...(byEmoji.get(emoji) ?? []), userId]);
  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, userIds }));
}

// Links still being fetched, or that had nothing to show, have no preview.
function linkPreviews(links: SelectedMessage["links"]): ChatLinkPreview[] {
  return links.flatMap(({ url, preview: { status, ...preview } }) => status === "OK" ? [{ url, ...preview }] : []);
}

// Voter ids are left out of anonymous polls, and of forwarded copies, which people who cannot see the
// original conversation may read.
function serializePoll(poll: NonNullable<SelectedMessage["poll"]>, showVoters: boolean): ChatPoll {
  const voters = new Set(poll.options.flatMap(option => option.votes.map(vote => vote.userId)));
  return {
    id: poll.id,
    multiSelect: poll.multiSelect,
    anonymous: poll.anonymous,
    closesAt: poll.closesAt?.toISOString() ?? null,
    closedAt: poll.closedAt?.toISOString() ?? null,
    voterCount: voters.size,
    options: poll.options.map(option => ({
      id: option.id,
      label: option.label,
      votes: option.votes.length,
      userIds: showVoters && !poll.anonymous ? option.votes.map(vote => vote.userId) : []
    })),
    myVotes: null
  };
}

function serializeForward(original: NonNullable<SelectedMessage["forwardedFrom"]>): ChatForward {
  const deleted = original.deletedAt !== null;
  const { type, isPrivate, name } = original.conversation;
  return {
    messageId: original.id,
    conversationId: original.conversationId,
    parentId: original.parentId,
    conversation: { type, isPrivate, name: type === "CHANNEL" && !isPrivate ? name : null },
    author: original.author,
    body: deleted ? "" : original.body,
    createdAt: original.createdAt.toISOString(),
    editedAt: original.editedAt?.toISOString() ?? null,
    deleted,
    attachments: deleted ? [] : original.attachments,
    poll: deleted || !original.poll ? null : serializePoll(original.poll, false)
  };
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
    attachments: deleted ? [] : message.attachments,
    linkPreviews: deleted ? [] : linkPreviews(message.links),
    forwarded: deleted || !message.forwardedFrom ? null : serializeForward(message.forwardedFrom),
    poll: deleted || !message.poll ? null : serializePoll(message.poll, true)
  };
}

// Records the links in a message body and queues their unfurl (src/lib/unfurl.ts). Call it with the
// transaction that writes the body, on create and on edit.
export async function syncMessageLinks(tx: Prisma.TransactionClient, messageId: string, body: string) {
  const urls = extractLinks(body);
  await tx.messageLink.deleteMany({ where: { messageId } });
  if (!urls.length) return;
  await tx.linkPreview.createMany({ data: urls.map(url => ({ url })), skipDuplicates: true });
  await tx.messageLink.createMany({ data: urls.map((url, position) => ({ messageId, position, url })) });
  await enqueue(tx, "message.unfurl", { messageId });
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
