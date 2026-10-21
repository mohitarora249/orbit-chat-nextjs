import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ARCHIVED_ERROR, isWorkspaceAdmin, requireMessageAccess } from "@/lib/access";
import { messageSelect, serializeMessage, syncMessageLinks } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { HttpError, jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ messageId: string }> };

const editSchema = z.object({ body: z.string().trim().max(4000) });

async function loadForChange(request: NextRequest, context: Context) {
  const { user, error } = await requireUser(request);
  if (error) return { error };
  const { messageId } = await context.params;
  const message = await requireMessageAccess(user.id, messageId);
  if (message.deletedAt) throw new HttpError(404, "Message not found.");
  return { user, message };
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const loaded = await loadForChange(request, context);
    if (loaded.error) return loaded.error;
    const { user, message } = loaded;
    if (message.authorId !== user.id) return jsonError("You can only edit your own messages.", 403);
    if (message.conversation.archivedAt) return jsonError(ARCHIVED_ERROR, 403);
    const { body } = await parseJson(request, editSchema);
    if (!body && !message.forwardedFromId && !(await prisma.attachment.count({ where: { messageId: message.id } }))) {
      return jsonError("A message needs text or an attachment.", 400);
    }

    const updated = await prisma.$transaction(async tx => {
      await tx.message.update({ where: { id: message.id }, data: { body, editedAt: new Date() } });
      await syncMessageLinks(tx, message.id, body);
      await enqueue(tx, "message.updated", { messageId: message.id });
      return tx.message.findUniqueOrThrow({ where: { id: message.id }, select: messageSelect });
    });
    notifyOutbox();
    return NextResponse.json({ message: serializeMessage(updated) });
  } catch (error) {
    return routeError("PATCH message", error, "Could not edit message.");
  }
}

// Soft delete: the row stays as a tombstone (body cleared) so threads and sync remain consistent.
// Authors can delete their own messages; workspace owners and admins can delete anyone's.
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const loaded = await loadForChange(request, context);
    if (loaded.error) return loaded.error;
    const { user, message } = loaded;
    if (message.authorId !== user.id && !(await isWorkspaceAdmin(user.id, message.conversation.workspaceId))) {
      return jsonError("You can only delete your own messages.", 403);
    }

    const deleted = await prisma.$transaction(async tx => {
      const result = await tx.message.update({ where: { id: message.id }, data: { body: "", deletedAt: new Date() }, select: messageSelect });
      await tx.reaction.deleteMany({ where: { messageId: message.id } });
      await enqueue(tx, "message.updated", { messageId: message.id });
      if (message.parentId) {
        await tx.message.update({ where: { id: message.parentId }, data: { replyCount: { decrement: 1 } } });
        await enqueue(tx, "message.updated", { messageId: message.parentId });
      }
      return result;
    });
    notifyOutbox();
    return NextResponse.json({ message: serializeMessage(deleted) });
  } catch (error) {
    return routeError("DELETE message", error, "Could not delete message.");
  }
}
