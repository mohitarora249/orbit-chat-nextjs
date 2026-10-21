import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ARCHIVED_ERROR, requireChannel } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, parseJson, routeError } from "@/lib/http";
import type { ChannelMember } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ conversationId: string }> };

function listMembers(conversationId: string) {
  return prisma.conversationMember.findMany({
    where: { conversationId },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    select: { userId: true, joinedAt: true }
  }).then(rows => rows.map((row): ChannelMember => ({ userId: row.userId, joinedAt: row.joinedAt.toISOString() })));
}

// The channel's members, earliest joined first. Anyone who can see the channel can list them.
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    await requireChannel(user.id, conversationId);
    return NextResponse.json({ members: await listMembers(conversationId) });
  } catch (error) {
    return routeError("GET channel members", error, "Could not load members.");
  }
}

const addMembersSchema = z.object({ userIds: z.array(z.string().min(1)).min(1).max(500) });

// Adds people to the channel. Sending only your own id joins a public channel; adding anyone else needs you
// to be a member. People who are already members are skipped. Responds with the full member list.
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const userIds = [...new Set((await parseJson(request, addMembersSchema)).userIds)];
    const channel = await requireChannel(user.id, conversationId);
    if (channel.archivedAt) return jsonError(ARCHIVED_ERROR, 403);
    const joiningSelf = userIds.length === 1 && userIds[0] === user.id;
    if (!channel.isMember && !joiningSelf) return jsonError("Join the channel before adding people to it.", 403);

    const valid = await prisma.workspaceMember.count({ where: { workspaceId: channel.workspaceId, userId: { in: userIds } } });
    if (valid !== userIds.length) return jsonError("Every member must belong to this workspace.", 400);

    const added = await prisma.$transaction(async tx => {
      const existing = await tx.conversationMember.findMany({ where: { conversationId, userId: { in: userIds } }, select: { userId: true } });
      const known = new Set(existing.map(member => member.userId));
      const newIds = userIds.filter(id => !known.has(id));
      if (!newIds.length) return 0;
      await tx.conversationMember.createMany({ data: newIds.map(userId => ({ conversationId, userId })), skipDuplicates: true });
      for (const userId of newIds) await enqueue(tx, "conversation.membership", { conversationId, userId });
      await enqueue(tx, "conversation.updated", { conversationId });
      return newIds.length;
    });
    if (added) notifyOutbox();
    return NextResponse.json({ members: await listMembers(conversationId) });
  } catch (error) {
    return routeError("POST channel members", error, "Could not add members.");
  }
}
