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
};

export type MessagePage = { messages: ChatMessage[]; nextCursor: string | null };

export type ConversationSummary = {
  id: string;
  name: string;
  type: "CHANNEL" | "DM";
  isPrivate: boolean;
  topic: string | null;
  // Populated for DMs (and private channels) so the client can label them.
  memberIds: string[];
  unreadCount: number;
  // Unread messages that @mention the viewer. From the server this counts top-level messages only; live
  // thread-reply mentions are added on the client until the conversation is opened.
  mentionCount: number;
  lastReadAt: string | null;
  lastMessage: { body: string; createdAt: string; author: { displayName: string } } | null;
};

export type Bootstrap = {
  me: ChatUser & { email: string };
  users: ChatUser[];
  // Custom statuses and Do Not Disturb in effect, by user id (see src/lib/presence.ts).
  statuses: Record<string, UserStatus>;
  workspace: { id: string; name: string; slug: string; role: "OWNER" | "ADMIN" | "MEMBER" };
  conversations: ConversationSummary[];
};

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
