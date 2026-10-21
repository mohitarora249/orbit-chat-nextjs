"use client";

import { ReactNode, useEffect, useState } from "react";
import { AtSign, Hash, Loader2, MessageSquareText, SmilePlus, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Composer } from "@/components/chat/composer";
import { MessageItem, type MessageActions } from "@/components/chat/message-item";
import { dayLabel, isGrouped, timeLabel } from "@/components/chat/helpers";
import { api } from "@/lib/api";
import { mentionsToText } from "@/lib/mentions";
import { customStatus, isDnd, presenceLabels, untilLabel, type Presence, type UserStatus } from "@/lib/presence";
import type { ActivityItem, ChatAttachment, ChatMessage, ChatUser } from "@/lib/types";

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
  conversationName: string;
  me: ChatUser;
  canModerate: boolean;
  usersById: Map<string, ChatUser>;
  typingText: string | null;
  highlightId: string | null;
  mentionable: ChatUser[];
  broadcastMentions: boolean;
  onClose: () => void;
  onLoadMore: () => void;
  onSend: (body: string, attachments: ChatAttachment[]) => Promise<boolean>;
  onTyping: (conversationId: string, parentId: string | null, typing: boolean) => void;
  onNotice: (message: string) => void;
};

export function ThreadPanel({ thread, conversationName, me, canModerate, usersById, typingText, highlightId, mentionable, broadcastMentions, onClose, onLoadMore, onSend, onTyping, onNotice, ...actions }: ThreadPanelProps) {
  const { parent, replies } = thread;
  return (
    <PanelShell title="Thread" subtitle={conversationName} onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {thread.loading && !parent ? (
          <div className="flex justify-center py-10 text-zinc-400"><Loader2 className="animate-spin" size={20}/></div>
        ) : parent && (
          <>
            <MessageItem message={parent} grouped={false} me={me} canModerate={canModerate} usersById={usersById} highlighted={highlightId === parent.id} {...actions}/>
            <div className="my-3 flex items-center gap-3 px-2 text-[11px] font-medium text-zinc-400">
              {parent.replyCount} {parent.replyCount === 1 ? "reply" : "replies"}<div className="h-px flex-1 bg-zinc-200"/>
            </div>
            {replies.map((reply, index) => (
              <MessageItem key={reply.id} message={reply} grouped={isGrouped(reply, replies[index - 1])} me={me} canModerate={canModerate} usersById={usersById} highlighted={highlightId === reply.id} {...actions}/>
            ))}
            {thread.nextCursor && (
              <button onClick={onLoadMore} disabled={thread.loading} className="mx-auto mt-3 block rounded-md border border-zinc-200 bg-card px-3 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:text-zinc-400">
                {thread.loading ? "Loading…" : "Load more replies"}
              </button>
            )}
          </>
        )}
      </div>
      {parent && !parent.deletedAt && (
        <div className="px-4 pb-4">
          <Composer key={thread.parentId} conversationId={parent.conversationId} parentId={parent.id} placeholder="Reply…" typingText={typingText} compact autoFocus mentionable={mentionable} broadcastMentions={broadcastMentions} onSend={onSend} onTyping={onTyping} onNotice={onNotice}/>
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
