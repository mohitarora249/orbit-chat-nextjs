import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ARCHIVED_ERROR, isWorkspaceAdmin, requireMessageAccess } from "@/lib/access";
import { messageSelect, serializeMessage } from "@/lib/messages";
import { castVote, closePoll, loadPollForAction, pollClosesAtSchema, reopenPoll, withMyVotes } from "@/lib/polls";
import { POLL_MAX_OPTIONS } from "@/lib/commands";
import { requireUser } from "@/lib/session";
import { notifyOutbox } from "@/lib/outbox";
import { HttpError, jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ messageId: string }> };

// Interactive parts of a message (ADR-016). Each action is named "<feature>.<verb>" and handled below.
const actionSchema = z.discriminatedUnion("action", [
  // Replaces the viewer's choices; an empty list takes their vote back.
  z.object({ action: z.literal("poll.vote"), optionIds: z.array(z.string().min(1).max(64)).max(POLL_MAX_OPTIONS) }),
  z.object({ action: z.literal("poll.close") }),
  // Without closesAt the poll stays open until closed by hand.
  z.object({ action: z.literal("poll.reopen"), closesAt: pollClosesAtSchema.optional() })
]);
type Action = z.infer<typeof actionSchema>;

type ActionContext = { tx: Prisma.TransactionClient; userId: string; message: Awaited<ReturnType<typeof requireMessageAccess>> };

async function requirePoll({ tx, message }: ActionContext) {
  const poll = await loadPollForAction(tx, message.id);
  if (!poll) throw new HttpError(400, "That message is not a poll.");
  return poll;
}

// Closing and reopening: the author, or a workspace owner or admin (who can also delete the message).
async function requireManagedPoll(context: ActionContext, verb: string) {
  const poll = await requirePoll(context);
  const { userId, message } = context;
  if (message.authorId !== userId && !(await isWorkspaceAdmin(userId, message.conversation.workspaceId))) {
    throw new HttpError(403, `Only the person who made the poll can ${verb} it.`);
  }
  return poll;
}

// Each handler runs inside the action's transaction and queues its own outbox events.
const handlers: { [A in Action["action"]]: (context: ActionContext, input: Extract<Action, { action: A }>) => Promise<void> } = {
  "poll.vote": async (context, { optionIds }) => {
    await castVote(context.tx, await requirePoll(context), context.userId, optionIds);
  },
  "poll.close": async (context) => {
    await closePoll(context.tx, await requireManagedPoll(context, "close"));
  },
  "poll.reopen": async (context, { closesAt }) => {
    await reopenPoll(context.tx, await requireManagedPoll(context, "reopen"), closesAt);
  }
};

export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { messageId } = await context.params;
    const input = await parseJson(request, actionSchema);
    const message = await requireMessageAccess(user.id, messageId);
    if (message.deletedAt) return jsonError("Message not found.", 404);
    if (message.conversation.archivedAt) return jsonError(ARCHIVED_ERROR, 403);

    const updated = await prisma.$transaction(async tx => {
      const handler = handlers[input.action] as (context: ActionContext, input: Action) => Promise<void>;
      await handler({ tx, userId: user.id, message }, input);
      return tx.message.findUniqueOrThrow({ where: { id: messageId }, select: messageSelect });
    });
    notifyOutbox();
    const [result] = await withMyVotes(user.id, [serializeMessage(updated)]);
    return NextResponse.json({ message: result });
  } catch (error) {
    return routeError("POST message action", error, "Could not complete that action.");
  }
}
