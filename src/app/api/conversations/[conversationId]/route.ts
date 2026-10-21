import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ARCHIVED_ERROR, requireChannel } from "@/lib/access";
import { channelNameSchema, loadConversation, MAX_DESCRIPTION_LENGTH, MAX_TOPIC_LENGTH, serializeDetails } from "@/lib/conversations";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { HttpError, jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ conversationId: string }> };

// Blank text clears the topic or description.
const optionalText = (max: number) => z.string().trim().max(max).transform(value => value || null).optional();

const updateChannelSchema = z.object({
  name: channelNameSchema.optional(),
  topic: optionalText(MAX_TOPIC_LENGTH),
  description: optionalText(MAX_DESCRIPTION_LENGTH),
  archived: z.boolean().optional()
}).refine(input => Object.values(input).some(value => value !== undefined), "Nothing to change.");

// Renames a channel, sets its topic or description, or archives or unarchives it. Members can set the topic
// and description; renaming and archiving need the channel's creator or a workspace owner or admin.
// Responds with the channel's shared details; everyone who can see it gets them as `conversation:updated`.
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { conversationId } = await context.params;
    const input = await parseJson(request, updateChannelSchema);
    const channel = await requireChannel(user.id, conversationId);

    if ((input.name !== undefined || input.archived !== undefined) && !channel.canManage) {
      return jsonError("Only the channel's creator or a workspace admin can rename or archive it.", 403);
    }
    if ((input.topic !== undefined || input.description !== undefined) && !channel.isMember && !channel.canManage) {
      return jsonError("Join the channel to change its topic or description.", 403);
    }
    // An archived channel only accepts being unarchived (possibly along with other changes).
    if (channel.archivedAt && input.archived !== false) return jsonError(ARCHIVED_ERROR, 403);

    const { archived, ...fields } = input;
    const data: Prisma.ConversationUpdateInput = { ...fields };
    if (archived !== undefined && archived !== Boolean(channel.archivedAt)) data.archivedAt = archived ? new Date() : null;

    try {
      await prisma.$transaction(async tx => {
        await tx.conversation.update({ where: { id: conversationId }, data });
        await enqueue(tx, "conversation.updated", { conversationId });
      });
    } catch (updateError) {
      if (updateError instanceof Prisma.PrismaClientKnownRequestError && updateError.code === "P2002") {
        throw new HttpError(409, `A channel named #${input.name} already exists.`);
      }
      throw updateError;
    }
    notifyOutbox();
    const updated = await loadConversation(conversationId);
    return NextResponse.json({ conversation: updated && serializeDetails(updated) });
  } catch (error) {
    return routeError("PATCH conversation", error, "Could not update channel.");
  }
}
