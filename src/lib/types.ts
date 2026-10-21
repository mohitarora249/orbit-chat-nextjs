import type { UserStatus } from "./presence";

export type ChatUser = {
  id: string;
  displayName: string;
  avatarColor: string;
};

export type AttachmentStatus = "PENDING_UPLOAD" | "SCANNING" | "CLEAN" | "INFECTED" | "FAILED";

export type ChatAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  status: AttachmentStatus;
};

export type ReactionSummary = { emoji: string; userIds: string[] };

// Open Graph data for a link in the message. imageUrl is always https and points at the linked site.
export type ChatLinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
};

export type ChatPollOption = { id: string; label: string; votes: number; userIds: string[] };

// A poll attached to a message; the message body is the question. `userIds` lists who chose each option,
// and is always empty in anonymous polls and in forwarded copies. A poll is closed once `closedAt` is set,
// which happens within a few seconds of `closesAt`.
export type ChatPoll = {
  id: string;
  multiSelect: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closedAt: string | null;
  // When it was last opened again after closing (still set if it has since closed again).
  reopenedAt: string | null;
  // People who voted (for at least one option, in a multiple-choice poll).
  voterCount: number;
  options: ChatPollOption[];
  // The viewer's own choices (option ids). Per-viewer, so it is set only on responses to the viewer's own
  // requests and is null on broadcasts, where clients keep what they had (see ADR-016).
  myVotes: string[] | null;
};

// An interaction with part of a message, sent to POST /api/messages/:id/actions.
export type MessageAction =
  | { action: "poll.vote"; optionIds: string[] }
  | { action: "poll.close" }
  // `closesAt` is the new closing time; without it the poll stays open until closed by hand.
  | { action: "poll.reopen"; closesAt?: string };

// The original of a forwarded message, shown as a quoted card. It is live: edits to the original show up
// here, and a deleted original leaves only `deleted`. The card is seen by people who may not be able to see
// the original conversation, so only public channels are named.
export type ChatForward = {
  messageId: string;
  conversationId: string;
  parentId: string | null;
  conversation: { type: "CHANNEL" | "DM"; isPrivate: boolean; name: string | null };
  author: ChatUser;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  attachments: ChatAttachment[];
  // Results only: voting happens in the original conversation.
  poll: ChatPoll | null;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  authorId: string;
  clientMessageId: string;
  body: string;
  parentId: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  author: ChatUser;
  reactions: ReactionSummary[];
  attachments: ChatAttachment[];
  linkPreviews: ChatLinkPreview[];
  forwarded: ChatForward | null;
  poll: ChatPoll | null;
};

export type MessagePage = { messages: ChatMessage[]; nextCursor: string | null };

export type ConversationSummary = {
  id: string;
  name: string;
  type: "CHANNEL" | "DM";
  isPrivate: boolean;
  topic: string | null;
  description: string | null;
  // Archived channels are read-only and leave the sidebar; they can still be opened and unarchived.
  archivedAt: string | null;
  createdById: string | null;
  // Populated for DMs (and private channels) so the client can label them.
  memberIds: string[];
  memberCount: number;
  // Whether the viewer is a member. Public channels the viewer has not joined can be previewed, not shown in
  // the sidebar. Per-viewer, so broadcasts set it for each audience (see conversation.created).
  isMember: boolean;
  unreadCount: number;
  // Unread messages that @mention the viewer. From the server this counts top-level messages only; live
  // thread-reply mentions are added on the client until the conversation is opened.
  mentionCount: number;
  lastReadAt: string | null;
  // DMs only (empty for channels): each member's read cursor by user id, for "Seen" receipts. Not per-viewer,
  // so it is safe on broadcast payloads; it only holds what both members can already see.
  readCursors: Record<string, string>;
  lastMessage: { body: string; createdAt: string; author: { displayName: string } } | null;
};

// The shared part of a conversation, broadcast as `conversation:updated` when it is renamed, its topic or
// description change, it is archived or unarchived, or its members change. Clients merge it into the summary.
export type ConversationDetails = Pick<ConversationSummary, "id" | "name" | "topic" | "description" | "archivedAt" | "memberIds" | "memberCount">;

export type ChannelMember = { userId: string; joinedAt: string };

export type Bootstrap = {
  me: ChatUser & { email: string };
  users: ChatUser[];
  // Custom statuses and Do Not Disturb in effect, by user id (see src/lib/presence.ts).
  statuses: Record<string, UserStatus>;
  workspace: { id: string; name: string; slug: string; role: "OWNER" | "ADMIN" | "MEMBER" };
  conversations: ConversationSummary[];
  // Conversations the user pinned to the top of their sidebar, in pin order.
  pinnedConversationIds: string[];
  // Unsent composer text, by conversation id.
  drafts: Record<string, Draft>;
  // The user's reminders that are not done yet (gone off or waiting), soonest first.
  reminders: ChatReminder[];
};

export type Gif = { id: string; title: string; url: string; width: number; height: number };

// A /remind reminder. `firedAt` is set once it has gone off, and cleared again by a snooze.
export type ChatReminder = { id: string; text: string; remindAt: string; firedAt: string | null; conversationId: string | null };

// Mentions in `body` are <@id> tokens, as in a message.
export type Draft = { body: string; updatedAt: string };

export type SearchHit = {
  message: ChatMessage;
  conversation: { id: string; name: string; type: "CHANNEL" | "DM" };
  snippet: string;
};

export type ActivityItem = {
  kind: "mention" | "reply" | "reaction";
  at: string;
  actor: ChatUser;
  conversationId: string;
  message: { id: string; body: string; parentId: string | null };
  emoji?: string;
};
