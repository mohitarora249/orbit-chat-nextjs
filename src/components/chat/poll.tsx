"use client";

import { useState } from "react";
import { Check, ChevronDown, Lock } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { dayLabel, isPollClosed, myPollVotes, timeLabel } from "@/components/chat/helpers";
import { reminderTimeLabel } from "@/lib/commands";
import { cn } from "@/lib/utils";
import type { ChatPoll, ChatUser } from "@/lib/types";

// When a poll closes by itself, chosen when it is made or reopened.
export const POLL_DURATIONS: { label: string; ms: number | null }[] = [
  { label: "Never", ms: null },
  { label: "In 1 hour", ms: 60 * 60 * 1000 },
  { label: "In 1 day", ms: 24 * 60 * 60 * 1000 },
  { label: "In 3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "In 1 week", ms: 7 * 24 * 60 * 60 * 1000 }
];

export function pollClosesAt(durationIndex: number) {
  const ms = POLL_DURATIONS[durationIndex].ms;
  return ms ? new Date(Date.now() + ms).toISOString() : undefined;
}

type Props = {
  poll: ChatPoll;
  me: ChatUser;
  usersById: Map<string, ChatUser>;
  // False for results only: forwarded copies, archived channels, messages still sending.
  interactive: boolean;
  // The author or a workspace admin: may close and reopen the poll.
  canManage?: boolean;
  onVote?: (optionIds: string[]) => void;
  onClosePoll?: () => void;
  // `closesAt` is the new closing time; without it the poll stays open until closed by hand.
  onReopen?: (closesAt: string | undefined) => void;
};

export function PollCard({ poll, me, usersById, interactive, canManage, onVote, onClosePoll, onReopen }: Props) {
  const closed = isPollClosed(poll);
  const canVote = interactive && !closed && Boolean(onVote);
  const mine = myPollVotes(poll, me.id);
  const top = Math.max(...poll.options.map(option => option.votes));
  // Named polls list who chose what; anonymous polls and forwarded copies carry no voter ids.
  const hasVoters = poll.options.some(option => option.userIds.length > 0);
  const [showVoters, setShowVoters] = useState(false);
  // Reopening asks for a new closing time first, since the old one may already have passed.
  const [reopening, setReopening] = useState(false);
  const [reopenDuration, setReopenDuration] = useState(0);
  const manage = canManage && interactive;

  // One choice: picking another moves the vote, picking yours again takes it back. Several: each toggles.
  function choose(optionId: string) {
    if (!onVote) return;
    const chosen = mine.includes(optionId);
    if (poll.multiSelect) onVote(chosen ? mine.filter(id => id !== optionId) : [...mine, optionId]);
    else onVote(chosen ? [] : [optionId]);
  }

  const voterNames = (userIds: string[]) => userIds.map(id => id === me.id ? "You" : usersById.get(id)?.displayName ?? "Someone").join(", ");

  return (
    <div className="mt-1.5 w-full max-w-md rounded-lg border border-zinc-200 bg-card p-1.5">
      <ul role="group" aria-label={poll.multiSelect ? "Choose any options" : "Choose one option"} className="space-y-1">
        {poll.options.map(option => {
          const chosen = mine.includes(option.id);
          const percent = poll.voterCount ? Math.round(option.votes / poll.voterCount * 100) : 0;
          const winner = closed && option.votes > 0 && option.votes === top;
          const voters = !poll.anonymous && option.userIds.length ? voterNames(option.userIds) : undefined;
          return (
            <li key={option.id}>
              <button type="button" disabled={!canVote} aria-pressed={chosen} onClick={() => choose(option.id)} title={voters}
                className={cn("relative flex w-full items-center gap-2.5 overflow-hidden rounded-md border px-2.5 py-1.5 text-left text-[13px] transition",
                  chosen ? "border-brand-200" : "border-transparent",
                  canVote ? "hover:border-zinc-300 active:scale-[0.99]" : "cursor-default")}>
                <span aria-hidden style={{ width: `${percent}%` }} className={cn("absolute inset-y-0 left-0 transition-[width] duration-300", chosen ? "bg-brand-100/80" : "bg-zinc-100")}/>
                <span aria-hidden className={cn("relative flex h-4 w-4 shrink-0 items-center justify-center border", poll.multiSelect ? "rounded" : "rounded-full",
                  chosen ? "border-brand-600 bg-brand-600 text-white" : "border-zinc-300 bg-card")}>
                  {chosen && <Check size={11} strokeWidth={3}/>}
                </span>
                <span className={cn("relative min-w-0 flex-1 break-words text-zinc-800", winner && "font-semibold")}>{option.label}</span>
                <span className="relative shrink-0 text-[11px] tabular-nums text-zinc-500">
                  {percent}%<span className="sr-only">, {option.votes} {option.votes === 1 ? "vote" : "votes"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 px-1 pb-0.5 text-[11px] text-zinc-400">
        <span>{poll.voterCount} {poll.voterCount === 1 ? "vote" : "votes"}</span>
        <span aria-hidden>·</span>
        <span>{poll.multiSelect ? "Choose any" : "Choose one"}</span>
        {poll.anonymous && <><span aria-hidden>·</span><span>Anonymous</span></>}
        <span aria-hidden>·</span>
        {closed
          ? <span className="flex items-center gap-1 font-medium text-zinc-500"><Lock size={10}/>Closed</span>
          : <span>{poll.closesAt ? `Closes ${reminderTimeLabel(new Date(poll.closesAt))}` : "Open"}</span>}
        {!closed && poll.reopenedAt && (
          <><span aria-hidden>·</span><span title={`Reopened ${dayLabel(poll.reopenedAt).toLowerCase()} at ${timeLabel(poll.reopenedAt)}`} className="font-medium text-amber-600">Reopened</span></>
        )}
        {hasVoters && (
          <>
            <span aria-hidden>·</span>
            <button type="button" aria-expanded={showVoters} onClick={() => setShowVoters(current => !current)}
              className="flex items-center gap-0.5 rounded px-0.5 font-medium text-brand-600 transition hover:text-brand-700 hover:underline">
              {showVoters ? "Hide votes" : "View votes"}<ChevronDown size={11} className={cn("transition-transform", showVoters && "rotate-180")}/>
            </button>
          </>
        )}
        {manage && !closed && onClosePoll && (
          <button type="button" onClick={() => { if (window.confirm("Close this poll? No one will be able to vote after that.")) onClosePoll(); }}
            className="ml-auto rounded px-1 font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800">Close poll</button>
        )}
        {manage && closed && onReopen && !reopening && (
          <button type="button" onClick={() => setReopening(true)}
            className="ml-auto rounded px-1 font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800">Reopen</button>
        )}
      </div>
      {manage && closed && onReopen && reopening && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-zinc-100 px-1 pt-2 text-[12px] text-zinc-600">
          <label className="flex items-center gap-2">Close again
            <select autoFocus value={reopenDuration} onChange={event => setReopenDuration(Number(event.target.value))} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setReopening(false); } }}
              className="rounded-md border border-zinc-200 bg-card px-2 py-1 text-xs outline-none focus:border-brand-300">
              {POLL_DURATIONS.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}
            </select>
          </label>
          <span className="ml-auto flex gap-1.5">
            <button type="button" onClick={() => setReopening(false)} className="rounded-md px-2 py-1 font-medium text-zinc-500 transition hover:bg-zinc-100">Cancel</button>
            <button type="button" onClick={() => { setReopening(false); onReopen(pollClosesAt(reopenDuration)); }}
              className="rounded-md bg-zinc-900 px-2.5 py-1 font-medium text-zinc-50 transition hover:bg-zinc-800">Reopen poll</button>
          </span>
        </div>
      )}
      {hasVoters && showVoters && (
        <div className="mt-1 max-h-72 space-y-2.5 overflow-y-auto border-t border-zinc-100 px-1 pb-1 pt-2">
          {poll.options.map(option => (
            <section key={option.id} aria-label={`Votes for ${option.label}`}>
              <h4 className="flex items-baseline gap-1.5 text-[12px] font-medium text-zinc-700">
                <span className="min-w-0 break-words">{option.label}</span>
                <span className="shrink-0 tabular-nums text-zinc-400">{option.votes}</span>
              </h4>
              {option.userIds.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1">
                  {option.userIds.map(userId => {
                    const user = usersById.get(userId);
                    const name = userId === me.id ? "You" : user?.displayName ?? "Someone";
                    return (
                      <li key={userId} className="flex items-center gap-1.5 rounded-md bg-zinc-50 py-0.5 pl-0.5 pr-2 text-[12px] text-zinc-700">
                        <Avatar name={user?.displayName ?? name} color={user?.avatarColor} size="sm"/>{name}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-0.5 text-[11px] text-zinc-400">No votes</p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
