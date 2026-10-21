import { EventEmitter } from "node:events";
import type { Prisma } from "@prisma/client";

export type OutboxPayloads = {
  "message.created": { messageId: string };
  "message.updated": { messageId: string };
  "message.unfurl": { messageId: string };
  "conversation.created": { conversationId: string };
  "conversation.read": { conversationId: string; userId: string; lastReadAt: string };
  "attachment.scan": { attachmentId: string };
  "user.status": { userId: string };
};
export type OutboxEventType = keyof OutboxPayloads;

// Must be called with the transaction client that writes the change itself, so the event exists if and
// only if the change committed.
export function enqueue<T extends OutboxEventType>(tx: Prisma.TransactionClient, type: T, payload: OutboxPayloads[T]) {
  return tx.outboxEvent.create({ data: { type, payload, availableAt: new Date() } });
}

// Route handlers run in the same process as the worker (see server.ts), so they can wake it right after a
// commit instead of waiting for the next poll. Cached on globalThis so Next.js module reloads share it.
const globalForOutbox = globalThis as unknown as { outboxSignal?: EventEmitter };
export const outboxSignal = globalForOutbox.outboxSignal ?? new EventEmitter();
globalForOutbox.outboxSignal = outboxSignal;

export function notifyOutbox() {
  outboxSignal.emit("kick");
}
