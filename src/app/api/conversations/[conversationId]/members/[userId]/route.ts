import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ARCHIVED_ERROR, requireChannel } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { HttpError, jsonError, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ conversationId: string; userId: string }> };

// Your own id leaves the channel (allowed even when it is archived). Removing someone else needs the
// channel's creator or a workspace owner or admin. Leaving or being removed from a private channel takes it
// away entirely, so its last member cannot leave: archive it instead.
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId, userId } = await context.params;
    const channel = await requireChannel(user.id, conversationId);
    const leaving = userId === user.id;
    if (!leaving) {
      if (!channel.canManage) return jsonError("Only the channel's creator or a workspace admin can remove people.", 403);
      if (channel.archivedAt) return jsonError(ARCHIVED_ERROR, 403);
    }

    await prisma.$transaction(async tx => {
      if (channel.isPrivate && leaving) {
        const count = await tx.conversationMember.count({ where: { conversationId } });
        if (count <= 1 && channel.isMember) throw new HttpError(409, "You're the last member of this private channel. Archive it instead of leaving.");
      }
      const removed = await tx.conversationMember.deleteMany({ where: { conversationId, userId } });
      if (!removed.count) return;
      await enqueue(tx, "conversation.membership", { conversationId, userId });
      await enqueue(tx, "conversation.updated", { conversationId });
    });
    notifyOutbox();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return routeError("DELETE channel member", error, "Could not remove member.");
  }
}
