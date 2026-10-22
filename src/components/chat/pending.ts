import { withVote } from "@/components/chat/helpers";
import type { ChatMessage, ReactionSummary } from "@/lib/types";

// A change to a message that is shown before the server confirms it. Ops sit beside the server's copy of each
// message and are applied when rendering, so a broadcast arriving mid-request cannot undo what the viewer did.
// A failed op stays until it is retried or dismissed: failed edits keep showing the new text, while failed
// reactions and deletes stop applying and the message shows what went wrong instead.
export type MessageOp = {
  // One op per message and kind (and emoji, for reactions); a newer change replaces the older one.
  key: string;
  // Tells the request behind the op in the map apart from one it replaced.
  seq: number;
  // For sends, the optimistic message's id.
  messageId: string;
  status: "pending" | "failed";
  error: string | null;
  // The request never reached the server, so it is retried by itself after reconnecting. Sends stay pending
  // meanwhile, queued in IndexedDB (see offline-queue.ts); other changes are marked failed.
  network: boolean;
} & (
  | { kind: "send"; message: ChatMessage }
  | { kind: "react"; emoji: string; add: boolean }
  | { kind: "edit"; body: string }
  | { kind: "delete" }
  // The viewer's full set of choices in the message's poll.
  | { kind: "vote"; optionIds: string[] }
);

// The parts of an op that say what it does (no bookkeeping).
export type OpChange =
  | { kind: "send"; messageId: string; message: ChatMessage }
  | { kind: "react"; messageId: string; emoji: string; add: boolean }
  | { kind: "edit"; messageId: string; body: string }
  | { kind: "delete"; messageId: string }
  | { kind: "vote"; messageId: string; optionIds: string[] };

export type PendingOps = Record<string, MessageOp>;

export function opKey(change: OpChange) {
  if (change.kind === "send") return `send:${change.message.clientMessageId}`;
  if (change.kind === "react") return `react:${change.messageId}:${change.emoji}`;
  return `${change.kind}:${change.messageId}`;
}

// What to show for a request that failed. fetch rejects with a TypeError when the server can't be reached.
export function failureText(error: unknown, fallback: string) {
  if (error instanceof TypeError) return "Couldn't reach the server.";
  return error instanceof Error ? error.message : fallback;
}

export function opsByMessage(ops: PendingOps) {
  const byMessage = new Map<string, MessageOp[]>();
  for (const op of Object.values(ops)) byMessage.set(op.messageId, [...byMessage.get(op.messageId) ?? [], op]);
  return byMessage;
}

export function toggleReaction(reactions: ReactionSummary[], emoji: string, add: boolean, meId: string) {
  if (!add) return reactions.map(r => r.emoji === emoji ? { ...r, userIds: r.userIds.filter(id => id !== meId) } : r).filter(r => r.userIds.length);
  return reactions.some(r => r.emoji === emoji)
    ? reactions.map(r => r.emoji === emoji ? { ...r, userIds: [...new Set([...r.userIds, meId])] } : r)
    : [...reactions, { emoji, userIds: [meId] }];
}

// The message as the viewer should see it. Unchanged messages keep their identity, so memoized rows stay put.
export function withOps(message: ChatMessage, ops: MessageOp[] | undefined, meId: string): ChatMessage {
  if (!ops) return message;
  let shown = message;
  for (const op of ops) {
    if (op.kind === "edit") shown = { ...shown, body: op.body };
    else if (op.status === "failed") continue;
    else if (op.kind === "react") shown = { ...shown, reactions: toggleReaction(shown.reactions, op.emoji, op.add, meId) };
    else if (op.kind === "vote") shown = shown.poll ? { ...shown, poll: withVote(shown.poll, meId, op.optionIds) } : shown;
    else if (op.kind === "delete") shown = { ...shown, deletedAt: shown.deletedAt ?? new Date().toISOString() };
  }
  return shown;
}

// A list with ops applied. A deleted message with no thread disappears, as it does once the server confirms.
export function applyOps(list: ChatMessage[], byMessage: Map<string, MessageOp[]>, meId: string) {
  if (!byMessage.size) return list;
  let changed = false;
  const shown: ChatMessage[] = [];
  for (const message of list) {
    const next = withOps(message, byMessage.get(message.id), meId);
    if (next !== message) changed = true;
    if (!next.deletedAt || next.replyCount > 0 || message.deletedAt) shown.push(next);
  }
  return changed ? shown : list;
}

// My unsent messages, oldest first, to put back in a fresh list: a thread's replies when `parentId` is set,
// otherwise a conversation's top-level messages.
export function outgoing(ops: PendingOps, conversationId: string | null, parentId: string | null) {
  const belongs = (message: ChatMessage) => parentId ? message.parentId === parentId : !message.parentId && message.conversationId === conversationId;
  return Object.values(ops)
    .flatMap(op => op.kind === "send" && belongs(op.message) ? [op.message] : [])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
