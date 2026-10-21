import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { HttpError } from "./errors";

export type ConversationAccess = "ok" | "not_found" | "not_workspace_member" | "not_conversation_member";

export const accessErrors: Record<Exclude<ConversationAccess, "ok">, { status: number; error: string }> = {
  not_found: { status: 404, error: "Conversation not found." },
  not_workspace_member: { status: 403, error: "Not a workspace member." },
  not_conversation_member: { status: 403, error: "Not a conversation member." }
};

// Single source of truth for conversation authorization, shared by the API routes and the socket server.
export async function getConversationAccess(userId: string, conversationId: string): Promise<ConversationAccess> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      type: true,
      isPrivate: true,
      workspace: { select: { members: { where: { userId }, select: { id: true }, take: 1 } } },
      members: { where: { userId }, select: { id: true }, take: 1 }
    }
  });
  if (!conversation) return "not_found";
  if (!conversation.workspace.members.length) return "not_workspace_member";
  if ((conversation.isPrivate || conversation.type === "DM") && !conversation.members.length) return "not_conversation_member";
  return "ok";
}

// The same rule as getConversationAccess, as a query filter: public channels in the user's workspaces,
// plus private channels and DMs they are a member of. Used for listing, search and socket room joins.
export function visibleConversationsWhere(userId: string, workspaceId?: string): Prisma.ConversationWhereInput {
  return {
    ...(workspaceId ? { workspaceId } : {}),
    workspace: { members: { some: { userId } } },
    OR: [{ type: "CHANNEL", isPrivate: false }, { members: { some: { userId } } }]
  };
}

// Loads a message the user can see, or throws a 404/403 HttpError.
export async function requireMessageAccess(userId: string, messageId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, authorId: true, parentId: true, forwardedFromId: true, deletedAt: true, conversation: { select: { workspaceId: true, archivedAt: true } } }
  });
  if (!message) throw new HttpError(404, "Message not found.");
  const access = await getConversationAccess(userId, message.conversationId);
  if (access !== "ok") throw new HttpError(accessErrors[access].status, accessErrors[access].error);
  return message;
}

export async function isWorkspaceAdmin(userId: string, workspaceId: string) {
  const link = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } });
  return link?.role === "OWNER" || link?.role === "ADMIN";
}

export const ARCHIVED_ERROR = "This channel is archived. Unarchive it to post or make changes.";

// Archived channels are read-only: no new messages, replies, uploads, edits or reactions. Deleting a message
// is still allowed, so moderators can clean one up.
export async function assertNotArchived(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { archivedAt: true } });
  if (conversation?.archivedAt) throw new HttpError(403, ARCHIVED_ERROR);
}

// Loads a channel the user can see, for the channel management routes, with what the user may do to it.
// Members can set the topic and description and add people; the channel's creator and workspace owners and
// admins can also rename, archive and remove people. DMs have none of this.
export async function requireChannel(userId: string, conversationId: string) {
  const access = await getConversationAccess(userId, conversationId);
  if (access !== "ok") throw new HttpError(accessErrors[access].status, accessErrors[access].error);
  const channel = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { id: true, workspaceId: true, type: true, isPrivate: true, archivedAt: true, createdById: true, members: { where: { userId }, select: { id: true }, take: 1 } }
  });
  if (channel.type !== "CHANNEL") throw new HttpError(400, "Direct messages cannot be managed like channels.");
  const isMember = channel.members.length > 0;
  const canManage = channel.createdById === userId || (await isWorkspaceAdmin(userId, channel.workspaceId));
  return { ...channel, isMember, canManage };
}
