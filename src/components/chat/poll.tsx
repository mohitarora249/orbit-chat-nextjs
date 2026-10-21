"use client";

import { useState } from "react";
import { Check, ChevronDown, Lock } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { isPollClosed, myPollVotes } from "@/components/chat/helpers";
import { reminderTimeLabel } from "@/lib/commands";
import { cn } from "@/lib/utils";
import type { ChatPoll, ChatUser } from "@/lib/types";

type Props = {
  poll: ChatPoll;
  me: ChatUser;
  usersById: Map<string, ChatUser>;
  // False for results only: forwarded copies, archived channels, messages still sending.
  interactive: boolean;
  canClose?: boolean;
  onVote?: (optionIds: string[]) => void;
  onClosePoll?: () => void;
};

export function PollCard({ poll, me, usersById, interactive, canClose, onVote, onClosePoll }: Props) {
  const closed = isPollClosed(poll);
  const canVote = interactive && !closed && Boolean(onVote);
  const mine = myPollVotes(poll, me.id);
  const top = Math.max(...poll.options.map(option => option.votes));
  // Named polls list who chose what; anonymous polls and forwarded copies carry no voter ids.
  const hasVoters = poll.options.some(option => option.userIds.length > 0);
  const [showVoters, setShowVoters] = useState(false);

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
        {hasVoters && (
          <>
            <span aria-hidden>·</span>
            <button type="button" aria-expanded={showVoters} onClick={() => setShowVoters(current => !current)}
              className="flex items-center gap-0.5 rounded px-0.5 font-medium text-brand-600 transition hover:text-brand-700 hover:underline">
              {showVoters ? "Hide votes" : "View votes"}<ChevronDown size={11} className={cn("transition-transform", showVoters && "rotate-180")}/>
            </button>
          </>
        )}
        {canClose && interactive && !closed && onClosePoll && (
          <button type="button" onClick={() => { if (window.confirm("Close this poll? No one will be able to vote after that.")) onClosePoll(); }}
            className="ml-auto rounded px-1 font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800">Close poll</button>
        )}
      </div>
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
