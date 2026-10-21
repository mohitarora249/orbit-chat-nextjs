import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getPrimaryWorkspaceLink } from "@/lib/workspace";
import { conversationSelect, serializeConversation } from "@/lib/conversations";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const openDmSchema = z.object({ userId: z.string().min(1) });

// Opens (finding or creating) the DM between the signed-in user and another workspace member.
// A DM's name is its sorted member ids, so the (workspaceId, type, name) unique key makes this race-safe.
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { userId: otherId } = await parseJson(request, openDmSchema);
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);
    const workspaceId = workspaceLink.workspaceId;

    const other = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: otherId } } });
    if (!other) return jsonError("That person is not in this workspace.", 404);

    const memberIds = [...new Set([user.id, otherId])].sort();
    const name = memberIds.join(":");
    const where = { workspaceId_type_name: { workspaceId, type: "DM" as const, name } };

    const existing = await prisma.conversation.findUnique({ where, select: conversationSelect });
    if (existing) return NextResponse.json({ conversation: serializeConversation(existing) });

    try {
      const conversation = await prisma.$transaction(async tx => {
        const created = await tx.conversation.create({
          data: { workspaceId, name, type: "DM", isPrivate: true, createdById: user.id, members: { create: memberIds.map(userId => ({ userId })) } },
          select: conversationSelect
        });
        await enqueue(tx, "conversation.created", { conversationId: created.id });
        return created;
      });
      notifyOutbox();
      return NextResponse.json({ conversation: serializeConversation(conversation) }, { status: 201 });
    } catch (createError) {
      if (createError instanceof Prisma.PrismaClientKnownRequestError && createError.code === "P2002") {
        const winner = await prisma.conversation.findUnique({ where, select: conversationSelect });
        if (winner) return NextResponse.json({ conversation: serializeConversation(winner) });
      }
      throw createError;
    }
  } catch (error) {
    return routeError("POST /api/conversations/dm", error, "Could not open direct message.");
  }
}
