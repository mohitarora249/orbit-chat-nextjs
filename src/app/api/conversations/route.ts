import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getPrimaryWorkspaceLink } from "@/lib/workspace";
import { conversationSelect, listConversations, listPinnedConversationIds, serializeConversation } from "@/lib/conversations";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { HttpError, jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

// Lists the conversations the user can see, with unread counts, and which of them the user pinned.
// The client calls this after reconnecting.
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);
    const [conversations, pinnedConversationIds] = await Promise.all([
      listConversations(user.id, workspaceLink.workspaceId),
      listPinnedConversationIds(user.id, workspaceLink.workspaceId)
    ]);
    return NextResponse.json({ conversations, pinnedConversationIds });
  } catch (error) {
    return routeError("GET /api/conversations", error, "Could not load conversations.");
  }
}

const createChannelSchema = z.object({
  name: z.string().trim()
    .transform(value => value.toLowerCase().replace(/^#/, "").replace(/\s+/g, "-"))
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/, "Channel names may use lowercase letters, numbers, - and _ (max 80).")),
  topic: z.string().trim().max(250).optional(),
  isPrivate: z.boolean().default(false),
  memberIds: z.array(z.string().min(1)).max(500).default([])
});

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const input = await parseJson(request, createChannelSchema);
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);
    const workspaceId = workspaceLink.workspaceId;

    const memberIds = [...new Set([user.id, ...input.memberIds])];
    const validMembers = await prisma.workspaceMember.count({ where: { workspaceId, userId: { in: memberIds } } });
    if (validMembers !== memberIds.length) return jsonError("Every member must belong to this workspace.", 400);

    try {
      const conversation = await prisma.$transaction(async tx => {
        const created = await tx.conversation.create({
          data: {
            workspaceId,
            name: input.name,
            type: "CHANNEL",
            isPrivate: input.isPrivate,
            topic: input.topic || null,
            createdById: user.id,
            members: { create: memberIds.map(userId => ({ userId })) }
          },
          select: conversationSelect
        });
        await enqueue(tx, "conversation.created", { conversationId: created.id });
        return created;
      });
      notifyOutbox();
      return NextResponse.json({ conversation: serializeConversation(conversation) }, { status: 201 });
    } catch (createError) {
      if (createError instanceof Prisma.PrismaClientKnownRequestError && createError.code === "P2002") {
        throw new HttpError(409, `A channel named #${input.name} already exists.`);
      }
      throw createError;
    }
  } catch (error) {
    return routeError("POST /api/conversations", error, "Could not create channel.");
  }
}
