import type { ChatMessage, ChatUser, ConversationSummary } from "@/lib/types";

export function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(date);
}

export function isOptimistic(message: ChatMessage) {
  return message.id.startsWith("optimistic-");
}

export function compareMessages(a: ChatMessage, b: ChatMessage) {
  return a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function mergeMessages(...lists: ChatMessage[][]) {
  const byId = new Map<string, ChatMessage>();
  for (const message of lists.flat()) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages);
}

// Adds or replaces a message, also replacing the optimistic copy we sent ourselves (same clientMessageId).
// Confirmed messages stay in (createdAt, id) order; still-pending optimistic ones stay at the end.
export function upsertMessage(list: ChatMessage[], message: ChatMessage) {
  const rest = list.filter(item => item.id !== message.id && item.clientMessageId !== message.clientMessageId);
  if (isOptimistic(message)) return [...rest, message];
  return [...mergeMessages(rest.filter(item => !isOptimistic(item)), [message]), ...rest.filter(isOptimistic)];
}

export function isGrouped(message: ChatMessage, previous: ChatMessage | undefined) {
  return Boolean(previous && !previous.deletedAt && previous.authorId === message.authorId
    && dayLabel(previous.createdAt) === dayLabel(message.createdAt)
    && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60 * 1000);
}

export function conversationLabel(conversation: Pick<ConversationSummary, "type" | "name" | "memberIds">, meId: string, usersById: Map<string, ChatUser>) {
  if (conversation.type !== "DM") return conversation.name;
  const otherId = conversation.memberIds.find(id => id !== meId);
  if (!otherId) return `${usersById.get(meId)?.displayName ?? "You"} (you)`;
  return usersById.get(otherId)?.displayName ?? "Unknown person";
}

export function dmPartnerId(conversation: ConversationSummary, meId: string) {
  return conversation.memberIds.find(id => id !== meId) ?? meId;
}
