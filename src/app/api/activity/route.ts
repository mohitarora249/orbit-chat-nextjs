import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { visibleConversationsWhere } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { getPrimaryWorkspaceLink } from "@/lib/workspace";
import { jsonError, routeError } from "@/lib/http";
import { broadcastToken, userToken } from "@/lib/mentions";
import type { ActivityItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const LIMIT = 40;
const authorSelect = { select: { id: true, displayName: true, avatarColor: true } } as const;
const messageRef = { select: { id: true, body: true, parentId: true, conversationId: true } } as const;

// Recent things that involve the user: @mentions, replies in threads they started or joined, and
// reactions to their messages. Everything is restricted to conversations they can still see.
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);
    const visible = visibleConversationsWhere(user.id, workspaceLink.workspaceId);

    const [mentions, replies, reactions] = await Promise.all([
      prisma.message.findMany({
        // Direct mentions and @channel. @here only alerts people who are online when it is sent.
        where: { conversation: visible, deletedAt: null, authorId: { not: user.id }, OR: [{ body: { contains: userToken(user.id) } }, { body: { contains: broadcastToken("channel") } }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIMIT,
        select: { id: true, body: true, parentId: true, conversationId: true, createdAt: true, author: authorSelect }
      }),
      prisma.message.findMany({
        where: {
          conversation: visible,
          deletedAt: null,
          authorId: { not: user.id },
          parent: { OR: [{ authorId: user.id }, { replies: { some: { authorId: user.id } } }] }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIMIT,
        select: { id: true, body: true, parentId: true, conversationId: true, createdAt: true, author: authorSelect }
      }),
      prisma.reaction.findMany({
        where: { userId: { not: user.id }, message: { authorId: user.id, deletedAt: null, conversation: visible } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIMIT,
        select: { emoji: true, createdAt: true, user: authorSelect, message: messageRef }
      })
    ]);

    const mentionIds = new Set(mentions.map(mention => mention.id));
    const items: ActivityItem[] = [
      // A mention inside a reply to my thread shows up once, as a mention.
      ...mentions.map(message => ({ kind: "mention" as const, at: message.createdAt.toISOString(), actor: message.author, conversationId: message.conversationId, message })),
      ...replies.filter(reply => !mentionIds.has(reply.id)).map(message => ({
        kind: "reply" as const, at: message.createdAt.toISOString(), actor: message.author, conversationId: message.conversationId, message
      })),
      ...reactions.map(reaction => ({
        kind: "reaction" as const, at: reaction.createdAt.toISOString(), actor: reaction.user, conversationId: reaction.message.conversationId, message: reaction.message, emoji: reaction.emoji
      }))
    ]
      .map(item => ({ ...item, message: { id: item.message.id, body: item.message.body, parentId: item.message.parentId } }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, LIMIT);
    return NextResponse.json({ items });
  } catch (error) {
    return routeError("GET /api/activity", error, "Could not load activity.");
  }
}
