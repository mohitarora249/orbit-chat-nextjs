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
    select: { id: true, conversationId: true, authorId: true, parentId: true, deletedAt: true, conversation: { select: { workspaceId: true } } }
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
