"use client";

import { FormEvent, Fragment, KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Bell, BellOff, Hash, HelpCircle, Link2, Loader2, Lock, LogOut, Plus, Search } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, Popover } from "@/components/ui/overlay";
import { dayLabel, timeLabel } from "@/components/chat/helpers";
import { api } from "@/lib/api";
import { cn, HIGHLIGHT_END, HIGHLIGHT_START } from "@/lib/utils";
import type { ChatUser, ConversationSummary, SearchHit } from "@/lib/types";

type JumpItem = { key: string; label: string; icon: React.ReactNode; run: () => void };

function Snippet({ text }: { text: string }) {
  // ts_headline wraps matches in marker characters; render them as <mark> using text nodes only.
  const parts = text.split(new RegExp(`(${HIGHLIGHT_START}[^${HIGHLIGHT_END}]*${HIGHLIGHT_END})`));
  return (
    <>
      {parts.map((part, index) => part.startsWith(HIGHLIGHT_START)
        ? <mark key={index} className="rounded bg-amber-100 px-0.5 text-amber-900">{part.slice(1, -1)}</mark>
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

// ⌘K: jump to a channel or person, and full-text search across every message the user can see.
export function CommandPalette({ conversations, users, me, label, onOpenConversation, onOpenDm, onOpenHit, onClose }: {
  conversations: ConversationSummary[];
  users: ChatUser[];
  me: ChatUser;
  label: (conversation: ConversationSummary) => string;
  onOpenConversation: (id: string) => void;
  onOpenDm: (userId: string) => void;
  onOpenHit: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);

  const jumpItems = useMemo<JumpItem[]>(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    const channels = conversations.filter(c => c.type === "CHANNEL" && c.name.includes(q)).map(c => ({
      key: c.id, label: c.name, icon: c.isPrivate ? <Lock size={14}/> : <Hash size={14}/>, run: () => onOpenConversation(c.id)
    }));
    const people = users.filter(user => user.displayName.toLowerCase().includes(q)).map(user => ({
      key: user.id, label: user.id === me.id ? `${user.displayName} (you)` : user.displayName, icon: <Avatar name={user.displayName} color={user.avatarColor} size="sm"/>, run: () => onOpenDm(user.id)
    }));
    return [...channels, ...people].slice(0, q ? 6 : 8);
  }, [conversations, users, me.id, query, onOpenConversation, onOpenDm]);

  useEffect(() => {
    const q = query.trim();
    setError("");
    if (q.length < 2) { setHits([]); setNextCursor(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api<{ hits: SearchHit[]; nextCursor: string | null }>(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        setHits(data.hits);
        setNextCursor(data.nextCursor);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Search failed.");
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => setSelected(0), [query]);

  async function loadMore() {
    if (!nextCursor) return;
    const data = await api<{ hits: SearchHit[]; nextCursor: string | null }>(`/api/search?q=${encodeURIComponent(query.trim())}&cursor=${encodeURIComponent(nextCursor)}`);
    setHits(current => [...current, ...data.hits]);
    setNextCursor(data.nextCursor);
  }

  const total = jumpItems.length + hits.length;
  function run(index: number) {
    if (index < jumpItems.length) jumpItems[index].run();
    else if (hits[index - jumpItems.length]) onOpenHit(hits[index - jumpItems.length]);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected(value => Math.min(value + 1, total - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelected(value => Math.max(value - 1, 0)); }
    if (event.key === "Enter" && total) { event.preventDefault(); run(selected); }
  }

  const hitLabel = (hit: SearchHit) => {
    const conversation = conversations.find(c => c.id === hit.conversation.id);
    return conversation ? label(conversation) : hit.conversation.name;
  };

  return (
    <Dialog title="Jump to or search" onClose={onClose} className="max-w-xl">
      <div className="flex items-center gap-2.5 border-b border-zinc-100 px-4 py-3.5">
        <Search size={16} className="text-zinc-400"/>
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Search messages, channels and people" aria-label="Search" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"/>
        {searching && <Loader2 size={14} className="animate-spin text-zinc-400"/>}
      </div>
      <div className="max-h-[55vh] overflow-y-auto p-2">
        {jumpItems.length > 0 && <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-zinc-400">Jump to</div>}
        {jumpItems.map((item, index) => (
          <button key={item.key} onMouseEnter={() => setSelected(index)} onClick={item.run} className={cn("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm", selected === index ? "bg-zinc-100 text-zinc-900" : "text-zinc-700")}>
            <span className="text-zinc-400">{item.icon}</span><span className="truncate">{item.label}</span>
          </button>
        ))}
        {query.trim().length >= 2 && (
          <>
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-zinc-400">Messages</div>
            {error && <p className="px-3 py-2 text-xs text-rose-600">{error}</p>}
            {!searching && !error && hits.length === 0 && <p className="px-3 py-2 text-xs text-zinc-400">No messages match “{query.trim()}”.</p>}
            {hits.map((hit, index) => {
              const position = jumpItems.length + index;
              return (
                <button key={hit.message.id} onMouseEnter={() => setSelected(position)} onClick={() => onOpenHit(hit)} className={cn("flex w-full gap-3 rounded-md px-2.5 py-2.5 text-left", selected === position ? "bg-zinc-100" : "")}>
                  <Avatar name={hit.message.author.displayName} color={hit.message.author.avatarColor} size="sm"/>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-[11px] text-zinc-500">
                      <b className="font-medium text-zinc-900">{hit.message.author.displayName}</b>
                      <span className="truncate">{hit.conversation.type === "CHANNEL" ? "#" : ""}{hitLabel(hit)}{hit.message.parentId ? " · in a thread" : ""}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{dayLabel(hit.message.createdAt)} {timeLabel(hit.message.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-zinc-700"><Snippet text={hit.snippet}/></p>
                  </div>
                </button>
              );
            })}
            {nextCursor && <button onClick={() => void loadMore()} className="mx-auto mt-2 block rounded-md px-3 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100">More results</button>}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 border-t border-zinc-100 bg-zinc-50/60 px-4 py-2 text-[11px] text-zinc-400"><span>↑↓ navigate</span><span>Enter open</span><span>Esc close</span><span className="ml-auto hidden sm:inline">&quot;phrases&quot;, OR, -exclude</span></div>
    </Dialog>
  );
}

export function CreateChannelDialog({ users, me, onCreated, onClose }: { users: ChatUser[]; me: ChatUser; onCreated: (conversation: ConversationSummary) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const { conversation } = await api<{ conversation: ConversationSummary }>("/api/conversations", { method: "POST", json: { name, topic: topic || undefined, isPrivate, memberIds } });
      onCreated(conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create channel.");
    } finally {
      setPending(false);
    }
  }

  const preview = name.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
  const field = "mt-1.5 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm font-normal outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-100/60";
  return (
    <Dialog title="Create a channel" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <label className="block text-[13px] font-medium text-zinc-700">Name
          <div className="relative"><Hash size={14} className="absolute left-3 top-[17px] text-zinc-400"/><input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. plan-budget" className={cn(field, "pl-8")}/></div>
          {preview && preview !== name && <span className="mt-1 block text-[11px] font-normal text-zinc-400">Will be created as #{preview}</span>}
        </label>
        <label className="block text-[13px] font-medium text-zinc-700">Topic <span className="font-normal text-zinc-400">(optional)</span>
          <input maxLength={250} value={topic} onChange={event => setTopic(event.target.value)} placeholder="What's this channel about?" className={field}/>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 transition hover:bg-zinc-50">
          <input type="checkbox" checked={isPrivate} onChange={event => setIsPrivate(event.target.checked)} className="mt-0.5 accent-brand-600"/>
          <span><span className="flex items-center gap-1.5 text-[13px] font-medium"><Lock size={12}/>Make private</span><span className="mt-0.5 block text-[11px] text-zinc-500">Only invited members can see or join a private channel.</span></span>
        </label>
        <fieldset>
          <legend className="text-[13px] font-medium text-zinc-700">Add people <span className="font-normal text-zinc-400">{isPrivate ? "(they'll be the only members)" : "(optional)"}</span></legend>
          <div className="mt-1.5 max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-200 p-1.5">
            {users.filter(user => user.id !== me.id).map(user => (
              <label key={user.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
                <input type="checkbox" checked={memberIds.includes(user.id)} onChange={event => setMemberIds(current => event.target.checked ? [...current, user.id] : current.filter(id => id !== user.id))} className="accent-brand-600"/>
                <Avatar name={user.displayName} color={user.avatarColor} size="sm"/><span className="text-xs">{user.displayName}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={pending || !preview}>{pending ? "Creating…" : "Create channel"}</Button></div>
      </form>
    </Dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘ K / Ctrl K", "Jump to a conversation or search messages"],
  ["Enter", "Send message"],
  ["Shift + Enter", "New line"],
  ["Esc", "Close a dialog, panel or edit"],
  ["⌘ / / Ctrl /", "Show this help"]
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Help & keyboard shortcuts" onClose={onClose}>
      <div className="space-y-5 p-5 text-xs text-zinc-600">
        <table className="w-full"><tbody>
          {SHORTCUTS.map(([keys, action]) => (
            <tr key={keys} className="border-b border-zinc-100 last:border-0"><td className="py-2 pr-4"><kbd className="whitespace-nowrap rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">{keys}</kbd></td><td className="py-2">{action}</td></tr>
          ))}
        </tbody></table>
        <ul className="list-disc space-y-1.5 pl-4 leading-5">
          <li>Hover a message to react, reply in a thread, edit or delete it.</li>
          <li>Type <b>@</b> (or use the @ button) to mention someone; mentions appear in their Activity.</li>
          <li>Drop or paste files into the composer. Files are scanned for malware before anyone can download them.</li>
          <li>Search supports <b>"exact phrases"</b>, <b>OR</b> and <b>-excluded</b> words.</li>
        </ul>
      </div>
    </Dialog>
  );
}

export function WorkspaceMenu({ workspace, me, onCreateChannel, onHelp, onSignOut, onNotice, onClose }: {
  workspace: { name: string; role: string };
  me: ChatUser & { email: string };
  onCreateChannel: () => void;
  onHelp: () => void;
  onSignOut: () => void;
  onNotice: (message: string) => void;
  onClose: () => void;
}) {
  async function copyInvite() {
    const url = `${window.location.origin}/login?mode=signup`;
    try {
      await navigator.clipboard.writeText(url);
      onNotice("Invite link copied. Anyone who signs up with it joins this workspace.");
    } catch {
      onNotice(`Share this link to invite people: ${url}`);
    }
    onClose();
  }
  const item = "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-100";
  return (
    <Popover onClose={onClose} className="left-3 right-3 top-[58px] p-1.5">
      <div className="border-b border-zinc-100 px-2.5 pb-2.5 pt-1.5">
        <div className="text-sm font-semibold tracking-tight">{workspace.name}</div>
        <div className="mt-0.5 text-[11px] text-zinc-500">Signed in as {me.email} · {workspace.role.toLowerCase()}</div>
      </div>
      <div className="pt-1.5">
        <button className={item} onClick={() => { onClose(); onCreateChannel(); }}><Plus size={14}/>Create a channel</button>
        <button className={item} onClick={() => void copyInvite()}><Link2 size={14}/>Copy invite link</button>
        <button className={item} onClick={() => { onClose(); onHelp(); }}><HelpCircle size={14}/>Help & shortcuts</button>
        <button className={cn(item, "text-rose-600 hover:bg-rose-50")} onClick={onSignOut}><LogOut size={14}/>Sign out</button>
      </div>
    </Popover>
  );
}

export type NotificationPrefs = { desktop: boolean; sound: boolean; muted: string[] };

export function NotificationsMenu({ prefs, onChange, conversation, label, onClose }: {
  prefs: NotificationPrefs;
  onChange: (prefs: NotificationPrefs) => void;
  conversation: ConversationSummary | null;
  label: string;
  onClose: () => void;
}) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const muted = conversation ? prefs.muted.includes(conversation.id) : false;

  async function toggleDesktop() {
    if (prefs.desktop) return onChange({ ...prefs, desktop: false });
    if (permission === "unsupported") return;
    const result = permission === "granted" ? "granted" : await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") onChange({ ...prefs, desktop: true });
  }

  return (
    <Popover onClose={onClose} className="right-0 top-11 w-72 p-4 text-xs">
      <h3 className="text-sm font-semibold tracking-tight">Notifications</h3>
      <label className="mt-3 flex items-start gap-3">
        <input type="checkbox" checked={prefs.desktop} disabled={permission === "unsupported" || permission === "denied"} onChange={() => void toggleDesktop()} className="mt-0.5 accent-brand-600"/>
        <span><span className="font-medium">Desktop notifications</span><span className="mt-0.5 block text-[11px] text-zinc-500">
          {permission === "unsupported" ? "Not supported in this browser." : permission === "denied" ? "Blocked in your browser settings." : "For direct messages and @mentions when you are not looking at that conversation."}
        </span></span>
      </label>
      <label className="mt-3 flex items-start gap-3">
        <input type="checkbox" checked={prefs.sound} onChange={() => onChange({ ...prefs, sound: !prefs.sound })} className="mt-0.5 accent-brand-600"/>
        <span><span className="font-medium">Sounds</span><span className="mt-0.5 block text-[11px] text-zinc-500">
          A soft blip for new messages, a chime for direct messages and @mentions.
        </span></span>
      </label>
      {conversation && (
        <button onClick={() => onChange({ ...prefs, muted: muted ? prefs.muted.filter(id => id !== conversation.id) : [...prefs.muted, conversation.id] })}
          className="mt-4 flex w-full items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 font-medium transition hover:bg-zinc-50">
          {muted ? <Bell size={14}/> : <BellOff size={14}/>}{muted ? "Unmute" : "Mute"} {conversation.type === "CHANNEL" ? "#" : ""}{label}
        </button>
      )}
      <p className="mt-3 text-[11px] text-zinc-400">Muted conversations still show unread counts but never notify or play sounds. Preferences are saved in this browser.</p>
    </Popover>
  );
}
