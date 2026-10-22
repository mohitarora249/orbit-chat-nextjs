"use client";

import { ReactNode, useEffect, useState } from "react";
import { AlarmClock, AtSign, Hash, Loader2, MessageSquareText, SmilePlus, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Composer, type ComposerProps } from "@/components/chat/composer";
import { MessageItem, type MessageActions } from "@/components/chat/message-item";
import { dayLabel, isGrouped, timeLabel } from "@/components/chat/helpers";
import type { MessageOp } from "@/components/chat/pending";
import { api } from "@/lib/api";
import { mentionsToText } from "@/lib/mentions";
import { customStatus, isDnd, presenceLabels, untilLabel, type Presence, type UserStatus } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { ActivityItem, ChatAttachment, ChatMessage, ChatReminder, ChatUser } from "@/lib/types";

function PanelShell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[420px] shrink-0 animate-fade-up flex-col border-l border-zinc-200/80 bg-card shadow-soft sm:w-[380px] xl:static xl:z-auto xl:shadow-none">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-zinc-200/80 px-4">
        <div className="flex min-w-0 items-baseline gap-2"><h2 className="shrink-0 text-[15px] font-semibold tracking-tight">{title}</h2>{subtitle && <p className="truncate text-[13px] text-zinc-400">{subtitle}</p>}</div>
        <button onClick={onClose} aria-label={`Close ${title}`} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={16}/></button>
      </div>
      {children}
    </aside>
  );
}

export type ThreadState = { parentId: string; parent: ChatMessage | null; replies: ChatMessage[]; nextCursor: string | null; loading: boolean };

type ThreadPanelProps = Omit<MessageActions, "onOpenThread"> & {
  thread: ThreadState;
  // Unconfirmed or failed changes, by message id.
  ops: Map<string, MessageOp[]>;
  conversationName: string;
  me: ChatUser;
  canModerate: boolean;
  usersById: Map<string, ChatUser>;
  typingText: string | null;
  highlightId: string | null;
  mentionable: ChatUser[];
  broadcastMentions: boolean;
  // Shown instead of the reply box when the channel is archived.
  readOnlyNotice?: string | null;
  onClose: () => void;
  onLoadMore: () => void;
  onSend: (body: string, attachments: ChatAttachment[]) => Promise<boolean>;
  onTyping: (conversationId: string, parentId: string | null, typing: boolean) => void;
  onNotice: (message: string) => void;
  // The message ↑ asked to edit in this thread, if any.
  editRequestId: string | null;
  onEditLast: () => boolean;
  onCommand: ComposerProps["onCommand"];
};

export function ThreadPanel({ thread, ops, conversationName, me, canModerate, usersById, typingText, highlightId, mentionable, broadcastMentions, readOnlyNotice, onClose, onLoadMore, onSend, onTyping, onNotice, editRequestId, onEditLast, onCommand, ...actions }: ThreadPanelProps) {
  const { parent, replies } = thread;
  return (
    <PanelShell title="Thread" subtitle={conversationName} onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {thread.loading && !parent ? (
          <div className="flex justify-center py-10 text-zinc-400"><Loader2 className="animate-spin" size={20}/></div>
        ) : parent && (
          <>
            <MessageItem message={parent} grouped={false} me={me} canModerate={canModerate} usersById={usersById} highlighted={highlightId === parent.id} ops={ops.get(parent.id)} readOnly={Boolean(readOnlyNotice)} editRequested={editRequestId === parent.id} {...actions}/>
            <div className="my-3 flex items-center gap-3 px-2 text-[11px] font-medium text-zinc-400">
              {parent.replyCount} {parent.replyCount === 1 ? "reply" : "replies"}<div className="h-px flex-1 bg-zinc-200"/>
            </div>
            {replies.map((reply, index) => (
              <MessageItem key={reply.id} message={reply} grouped={isGrouped(reply, replies[index - 1])} me={me} canModerate={canModerate} usersById={usersById} highlighted={highlightId === reply.id} ops={ops.get(reply.id)} readOnly={Boolean(readOnlyNotice)} editRequested={editRequestId === reply.id} {...actions}/>
            ))}
            {thread.nextCursor && (
              <button onClick={onLoadMore} disabled={thread.loading} className="mx-auto mt-3 block rounded-md border border-zinc-200 bg-card px-3 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:text-zinc-400">
                {thread.loading ? "Loading…" : "Load more replies"}
              </button>
            )}
          </>
        )}
      </div>
      {parent && !parent.deletedAt && readOnlyNotice && <p className="mx-4 mb-4 rounded-lg bg-zinc-50 px-3 py-2.5 text-center text-xs text-zinc-500">{readOnlyNotice}</p>}
      {parent && !parent.deletedAt && !readOnlyNotice && (
        <div className="px-4 pb-4">
          <Composer key={thread.parentId} conversationId={parent.conversationId} parentId={parent.id} placeholder="Reply…" typingText={typingText} compact autoFocus mentionable={mentionable} broadcastMentions={broadcastMentions} onSend={onSend} onEditLast={onEditLast} onCommand={onCommand} onTyping={onTyping} onNotice={onNotice}/>
        </div>
      )}
    </PanelShell>
  );
}

const activityIcons = {
  mention: <AtSign size={12}/>,
  reply: <MessageSquareText size={12}/>,
  reaction: <SmilePlus size={12}/>
};

export function ActivityPanel({ usersById, conversationName, onOpen, onClose }: { usersById: Map<string, ChatUser>; conversationName: (id: string) => string; onOpen: (item: ActivityItem) => void; onClose: () => void }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ items: ActivityItem[] }>("/api/activity").then(data => setItems(data.items)).catch(err => setError(err instanceof Error ? err.message : "Could not load activity."));
  }, []);

  return (
    <PanelShell title="Activity" subtitle="Mentions, thread replies and reactions" onClose={onClose}>
      <div className="flex-1 overflow-y-auto p-3">
        {error && <p className="p-4 text-center text-xs text-rose-600">{error}</p>}
        {!items && !error && <div className="flex justify-center py-10 text-zinc-400"><Loader2 className="animate-spin" size={20}/></div>}
        {items?.length === 0 && <p className="px-4 py-12 text-center text-xs text-zinc-500">Nothing yet. Mentions of you, replies to your threads and reactions to your messages show up here.</p>}
        {items?.map((item, index) => (
          <button key={`${item.kind}-${item.message.id}-${item.actor.id}-${index}`} onClick={() => onOpen(item)} className="flex w-full gap-3 rounded-lg p-3 text-left transition hover:bg-zinc-50">
            <Avatar name={item.actor.displayName} color={item.actor.avatarColor} size="sm"/>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className="text-zinc-400">{activityIcons[item.kind]}</span>
                <span className="truncate"><b className="font-medium text-zinc-900">{item.actor.displayName}</b> {item.kind === "mention" ? "mentioned you" : item.kind === "reply" ? "replied in a thread" : <>reacted {item.emoji}</>}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-zinc-700">{mentionsToText(item.message.body, id => usersById.get(id)?.displayName) || "(attachment)"}</p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-zinc-400"><Hash size={10}/>{conversationName(item.conversationId)} · {dayLabel(item.at)} at {timeLabel(item.at)}</p>
            </div>
          </button>
        ))}
      </div>
    </PanelShell>
  );
}

function PersonStatus({ presence, status, now }: { presence: Presence; status: UserStatus | undefined; now: number }) {
  const custom = customStatus(status, now);
  const dnd = isDnd(status, now);
  return (
    <div className="truncate text-[11px] text-zinc-400">
      {custom ? <span className="text-zinc-600">{custom.emoji} {custom.text}</span> : presenceLabels[presence]}
      {dnd && <span className="text-rose-500"> · Notifications paused{status?.dndUntil ? ` until ${untilLabel(status.dndUntil)}` : ""}</span>}
    </div>
  );
}

const presenceRank: Record<Presence, number> = { active: 0, away: 1, offline: 2 };

export function PeoplePanel({ users, meId, presenceOf, statusOf, now, onOpenDm, onClose }: {
  users: ChatUser[];
  meId: string;
  presenceOf: (userId: string) => Presence;
  statusOf: (userId: string) => UserStatus | undefined;
  now: number;
  onOpenDm: (userId: string) => void;
  onClose: () => void;
}) {
  const sorted = [...users].sort((a, b) => presenceRank[presenceOf(a.id)] - presenceRank[presenceOf(b.id)] || a.displayName.localeCompare(b.displayName));
  const online = users.filter(user => presenceOf(user.id) !== "offline").length;
  return (
    <PanelShell title="People" subtitle={`${online} online · ${users.length} members`} onClose={onClose}>
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {sorted.map(user => (
          <button key={user.id} onClick={() => onOpenDm(user.id)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition hover:bg-zinc-50">
            <Avatar name={user.displayName} color={user.avatarColor} size="sm" presence={presenceOf(user.id)} dnd={isDnd(statusOf(user.id), now)}/>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{user.displayName}{user.id === meId && <span className="font-normal text-zinc-400"> (you)</span>}</div>
              <PersonStatus presence={presenceOf(user.id)} status={statusOf(user.id)} now={now}/>
            </div>
          </button>
        ))}
      </div>
    </PanelShell>
  );
}

// "Today at 3:20 PM", "Tomorrow at 9:00 AM", "Friday, Oct 24 at 9:00 AM".
function reminderWhen(value: string, now: number) {
  const days = Math.round((new Date(value).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return `${days === 1 ? "Tomorrow" : dayLabel(value)} at ${timeLabel(value)}`;
}

export function RemindersPanel({ reminders, now, sourceLabel, onOpenSource, onDone, onSnooze, onClose }: {
  // Soonest first.
  reminders: ChatReminder[];
  now: number;
  // Where a reminder was set ("#general", "Aisha Khan"), or null if the user can no longer see it.
  sourceLabel: (conversationId: string) => string | null;
  onOpenSource: (conversationId: string) => void;
  // Marks an overdue reminder done, or deletes an upcoming one.
  onDone: (reminder: ChatReminder) => void;
  onSnooze: (reminder: ChatReminder) => void;
  onClose: () => void;
}) {
  const overdue = reminders.filter(reminder => reminder.firedAt);
  const upcoming = reminders.filter(reminder => !reminder.firedAt);
  const row = (reminder: ChatReminder) => {
    const source = reminder.conversationId ? sourceLabel(reminder.conversationId) : null;
    return (
      <li key={reminder.id} className="group flex gap-3 rounded-lg p-3 transition hover:bg-zinc-50">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", reminder.firedAt ? "bg-brand-50 text-brand-600" : "bg-zinc-100 text-zinc-500")}><AlarmClock size={14}/></span>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-900">{reminder.text}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-zinc-400">
            <time dateTime={reminder.remindAt} className={cn(reminder.firedAt && "font-medium text-brand-600")}>{reminderWhen(reminder.remindAt, now)}</time>
            {source && <>·<button onClick={() => onOpenSource(reminder.conversationId!)} className="font-medium text-zinc-500 transition hover:text-zinc-800 hover:underline">{source}</button></>}
          </p>
          {reminder.firedAt && (
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" onClick={() => onDone(reminder)} className="h-7 px-2.5 text-xs">Mark as done</Button>
              <Button size="sm" variant="outline" onClick={() => onSnooze(reminder)} className="h-7 px-2.5 text-xs">Snooze 20 min</Button>
            </div>
          )}
        </div>
        {!reminder.firedAt && (
          <button title="Delete reminder" aria-label={`Delete reminder: ${reminder.text}`} onClick={() => onDone(reminder)}
            className="h-7 shrink-0 rounded-md p-1.5 text-zinc-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"><Trash2 size={14}/></button>
        )}
      </li>
    );
  };
  const section = (title: string, items: ChatReminder[]) => items.length > 0 && (
    <section className="mb-3">
      <h3 className="px-3 pb-1 pt-2 text-[11px] font-medium text-zinc-400">{title} · {items.length}</h3>
      <ul>{items.map(row)}</ul>
    </section>
  );
  return (
    <PanelShell title="Reminders" subtitle={reminders.length ? `${overdue.length} overdue · ${upcoming.length} upcoming` : undefined} onClose={onClose}>
      <div className="flex-1 overflow-y-auto p-3">
        {reminders.length === 0 && (
          <p className="px-4 py-12 text-center text-xs leading-5 text-zinc-500">
            No reminders. Type <code className="rounded border border-zinc-200 bg-zinc-50 px-1 py-0.5 font-mono text-[11px] text-zinc-700">/remind me to stretch in 20 minutes</code> in any message box to set one.
          </p>
        )}
        {section("Overdue", overdue)}
        {section("Upcoming", upcoming)}
      </div>
    </PanelShell>
  );
}

