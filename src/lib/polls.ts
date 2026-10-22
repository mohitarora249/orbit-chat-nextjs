import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";
import { POLL_MAX_OPEN_MS, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX } from "./commands";
import { HttpError } from "./errors";
import { enqueue, notifyOutbox } from "./outbox";
import type { ChatMessage } from "./types";

// How often each server process looks for polls whose closing time has passed. Polls close up to this late.
const CLOCK_INTERVAL_MS = 5000;
const BATCH_SIZE = 100;

// When a poll closes by itself: in the future, and within a year.
export const pollClosesAtSchema = z.iso.datetime().refine(value => {
  const at = new Date(value).getTime() - Date.now();
  return at > 0 && at < POLL_MAX_OPEN_MS;
}, "The closing time must be in the future and within a year.");

// The poll part of a new message; the message body is the question.
export const pollInputSchema = z.object({
  options: z.array(z.string().trim().min(1, "Options can't be empty.").max(POLL_OPTION_MAX, `Options can be up to ${POLL_OPTION_MAX} characters.`))
    .min(POLL_MIN_OPTIONS, `A poll needs at least ${POLL_MIN_OPTIONS} options.`)
    .max(POLL_MAX_OPTIONS, `A poll can have up to ${POLL_MAX_OPTIONS} options.`)
    .refine(options => new Set(options.map(option => option.toLowerCase())).size === options.length, "Each option must be different."),
  multiSelect: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  closesAt: pollClosesAtSchema.optional()
});
export type PollInput = z.infer<typeof pollInputSchema>;

// Call it with the transaction that creates the message.
export async function createPoll(tx: Prisma.TransactionClient, messageId: string, input: PollInput) {
  await tx.poll.create({
    data: {
      messageId,
      multiSelect: input.multiSelect,
      anonymous: input.anonymous,
      closesAt: input.closesAt ? new Date(input.closesAt) : null,
      options: { create: input.options.map((label, position) => ({ label, position })) }
    }
  });
}

// Fills in `myVotes` on the polls in messages sent to `userId` alone (history pages, threads, action
// results). Broadcasts leave it null.
export async function withMyVotes(userId: string, messages: ChatMessage[]) {
  const pollIds = messages.flatMap(message => message.poll ? [message.poll.id] : []);
  if (!pollIds.length) return messages;
  const votes = await prisma.pollVote.findMany({ where: { userId, pollId: { in: pollIds } }, select: { pollId: true, optionId: true } });
  return messages.map(message => message.poll
    ? { ...message, poll: { ...message.poll, myVotes: votes.filter(vote => vote.pollId === message.poll!.id).map(vote => vote.optionId) } }
    : message);
}

const pollForActionSelect = { id: true, messageId: true, multiSelect: true, closesAt: true, closedAt: true, options: { select: { id: true } } } as const;
type PollForAction = Prisma.PollGetPayload<{ select: typeof pollForActionSelect }>;

export function loadPollForAction(tx: Prisma.TransactionClient, messageId: string) {
  return tx.poll.findUnique({ where: { messageId }, select: pollForActionSelect });
}

export function isPollClosed(poll: Pick<PollForAction, "closesAt" | "closedAt">, now = new Date()) {
  return poll.closedAt !== null || (poll.closesAt !== null && poll.closesAt <= now);
}

// Replaces the user's choices with `optionIds` (empty takes the vote back). Returns whether anything changed.
export async function castVote(tx: Prisma.TransactionClient, poll: PollForAction, userId: string, optionIds: string[]) {
  if (isPollClosed(poll)) throw new HttpError(409, "This poll is closed.");
  const chosen = [...new Set(optionIds)];
  if (!poll.multiSelect && chosen.length > 1) throw new HttpError(400, "This poll allows one choice.");
  const valid = new Set(poll.options.map(option => option.id));
  if (chosen.some(id => !valid.has(id))) throw new HttpError(400, "That option is not in this poll.");

  // One voter at a time per poll, so two tabs voting at once cannot leave two choices in a one-choice poll.
  // Other voters are not held up.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`poll:${poll.id}:${userId}`}, 0))`;
  const before = await tx.pollVote.findMany({ where: { pollId: poll.id, userId }, select: { optionId: true } });
  if (before.length === chosen.length && before.every(vote => chosen.includes(vote.optionId))) return false;
  await tx.pollVote.deleteMany({ where: { pollId: poll.id, userId } });
  await tx.pollVote.createMany({ data: chosen.map(optionId => ({ pollId: poll.id, optionId, userId })) });
  await enqueue(tx, "message.updated", { messageId: poll.messageId });
  await enqueue(tx, "poll.voted", { userId, messageId: poll.messageId });
  return true;
}

export async function closePoll(tx: Prisma.TransactionClient, poll: PollForAction) {
  if (poll.closedAt) return false;
  await tx.poll.update({ where: { id: poll.id }, data: { closedAt: new Date() } });
  await enqueue(tx, "message.updated", { messageId: poll.messageId });
  return true;
}

// Opens a closed poll again, with a new closing time or none. Votes cast before it closed are kept. Also
// works on a poll whose closing time has just passed but that the clock has not closed yet; replacing
// closesAt in the same update means the clock cannot close it again straight away.
export async function reopenPoll(tx: Prisma.TransactionClient, poll: PollForAction, closesAt: string | undefined) {
  if (!isPollClosed(poll)) throw new HttpError(409, "This poll is already open.");
  await tx.poll.update({ where: { id: poll.id }, data: { closedAt: null, closesAt: closesAt ? new Date(closesAt) : null, reopenedAt: new Date() } });
  await enqueue(tx, "message.updated", { messageId: poll.messageId });
}

// Closes polls whose closing time has passed and queues their update in the same transaction. SKIP LOCKED
// lets several server instances run this.
async function closeDuePolls() {
  const closed = await prisma.$transaction(async tx => {
    const due = await tx.$queryRaw<{ messageId: string }[]>`
      UPDATE "Poll" SET "closedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT "id" FROM "Poll"
        WHERE "closedAt" IS NULL AND "closesAt" <= (now() AT TIME ZONE 'UTC')
        ORDER BY "closesAt"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "messageId"`;
    for (const poll of due) await enqueue(tx, "message.updated", { messageId: poll.messageId });
    return due.length;
  });
  if (closed) notifyOutbox();
  return closed;
}

export function startPollClock() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while (await closeDuePolls() === BATCH_SIZE) { /* keep going until caught up */ }
    } catch (error) {
      console.error("Poll clock failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CLOCK_INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
}
