"use client";

import { FormEvent, Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Bell, BellOff, CalendarDays, Check, Filter, Hash, HelpCircle, Link2, Loader2, Lock, Paperclip, LogOut, Monitor, Moon, Plus, Search, ShieldAlert, Sun, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, Popover } from "@/components/ui/overlay";
import { dayLabel, timeLabel } from "@/components/chat/helpers";
import { ForwardedCard, forwardSourceLabel } from "@/components/chat/message-item";
import { POLL_DURATIONS, pollClosesAt } from "@/components/chat/poll";
import { api } from "@/lib/api";
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "@/lib/commands";
import { mentionsToText } from "@/lib/mentions";
import { hasSearchFilters, parseSearch, personHandle, trailingFilter } from "@/lib/search";
import { ACCENTS, useTheme, type ThemeMode } from "@/lib/theme";
import { cn, HIGHLIGHT_END, HIGHLIGHT_START } from "@/lib/utils";
import type { ChatForward, ChatMessage, ChatUser, ConversationSummary, SearchHit } from "@/lib/types";

type JumpItem = { key: string; label: string; hint?: string; icon: React.ReactNode; run: () => void };

function Snippet({ text, nameOf }: { text: string; nameOf: (userId: string) => string | undefined }) {
  // ts_headline wraps matches in marker characters; render them as <mark> using text nodes only.
  const parts = mentionsToText(text, nameOf).split(new RegExp(`(${HIGHLIGHT_START}[^${HIGHLIGHT_END}]*${HIGHLIGHT_END})`));
  return (
    <>
      {parts.map((part, index) => part.startsWith(HIGHLIGHT_START)
        ? <mark key={index} className="rounded bg-amber-100 px-0.5 text-amber-900">{part.slice(1, -1)}</mark>
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

type SearchPage = { hits: SearchHit[]; nextCursor: string | null; notes: string[] };

const FILTER_STARTERS = ["in:#", "from:@", "has:file", "before:", "after:"];

function searchUrl(query: string, cursor?: string) {
  const params = new URLSearchParams({ q: query, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (cursor) params.set("cursor", cursor);
  return `/api/search?${params}`;
}

// ⌘K: jump to a channel or person, and full-text search across every message the user can see.
// Search filters (in:, from:, has:, before:/after:/on:) are completed from the same channel and people lists.
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
  const [notes, setNotes] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingFilter = useMemo(() => trailingFilter(query), [query]);
  const filtered = useMemo(() => hasSearchFilters(parseSearch(query)), [query]);

  const jumpItems = useMemo<JumpItem[]>(() => {
    if (typingFilter) {
      const { start, key, partial } = typingFilter;
      const complete = (text: string) => () => { setQuery(`${query.slice(0, start)}${text} `); inputRef.current?.focus(); };
      const channels = key === "in:#" || key === "in:"
        ? conversations.filter(c => c.type === "CHANNEL" && c.name.includes(partial)).map(c => ({
          key: c.id, label: `in:#${c.name}`, icon: c.isPrivate ? <Lock size={14}/> : <Hash size={14}/>, run: complete(`in:#${c.name}`)
        }))
        : [];
      const prefix = key.startsWith("from") ? "from:@" : key === "in:@" || key === "in:" ? "in:@" : null;
      const people = prefix
        ? users.filter(u => personHandle(u.displayName).includes(personHandle(partial))).map(u => ({
          key: u.id, label: `${prefix}${personHandle(u.displayName)}`, hint: u.id === me.id ? `${u.displayName} (you)` : u.displayName,
          icon: <Avatar name={u.displayName} color={u.avatarColor} size="sm"/>, run: complete(`${prefix}${personHandle(u.displayName)}`)
        }))
        : [];
      const fixed = key === "has:"
        ? [{ key: "has:file", label: "has:file", hint: "Messages with files", icon: <Paperclip size={14}/>, run: complete("has:file") },
          { key: "has:link", label: "has:link", hint: "Messages with links", icon: <Link2 size={14}/>, run: complete("has:link") }]
        : ["before:", "after:", "on:"].includes(key)
          ? ["today", "yesterday"].map(day => ({ key: day, label: `${key}${day}`, hint: "or YYYY-MM-DD", icon: <CalendarDays size={14}/>, run: complete(`${key}${day}`) }))
          : key === "from:" || key === "from:@" ? [{ key: "from:me", label: "from:me", hint: "Your messages", icon: <AtSign size={14}/>, run: complete("from:me") }] : [];
      return [...fixed, ...channels, ...people].filter(item => item.label.toLowerCase().includes(partial)).slice(0, 8);
    }
    if (filtered) return [];
    const q = query.trim().toLowerCase().replace(/^#/, "");
    const channels = conversations.filter(c => c.type === "CHANNEL" && c.name.includes(q)).map(c => ({
      key: c.id, label: c.name, icon: c.isPrivate ? <Lock size={14}/> : <Hash size={14}/>, run: () => onOpenConversation(c.id)
    }));
    const people = users.filter(user => user.displayName.toLowerCase().includes(q)).map(user => ({
      key: user.id, label: user.id === me.id ? `${user.displayName} (you)` : user.displayName, icon: <Avatar name={user.displayName} color={user.avatarColor} size="sm"/>, run: () => onOpenDm(user.id)
    }));
    return [...channels, ...people].slice(0, q ? 6 : 8);
  }, [conversations, users, me.id, query, typingFilter, filtered, onOpenConversation, onOpenDm]);

  useEffect(() => {
    const q = query.trim();
    setError("");
    if (q.length < 2) { setHits([]); setNextCursor(null); setNotes([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api<SearchPage>(searchUrl(q), { signal: controller.signal });
        setHits(data.hits);
        setNextCursor(data.nextCursor);
        setNotes(data.notes);
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
    const data = await api<SearchPage>(searchUrl(query.trim(), nextCursor));
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
        <input ref={inputRef} autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Search, or filter with in:#channel from:@person has:file" aria-label="Search" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"/>
        {searching && <Loader2 size={14} className="animate-spin text-zinc-400"/>}
      </div>
      <div className="max-h-[55vh] overflow-y-auto p-2">
        {jumpItems.length > 0 && <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-zinc-400">{typingFilter ? "Filters" : "Jump to"}</div>}
        {jumpItems.map((item, index) => (
          <button key={item.key} onMouseEnter={() => setSelected(index)} onClick={item.run} className={cn("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm", selected === index ? "bg-zinc-100 text-zinc-900" : "text-zinc-700")}>
            <span className="text-zinc-400">{item.icon}</span><span className={cn("truncate", typingFilter && "font-mono text-[13px]")}>{item.label}</span>
            {item.hint && <span className="ml-auto truncate text-xs text-zinc-400">{item.hint}</span>}
          </button>
        ))}
        {!query.trim() && (
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1 pt-3 text-[11px] text-zinc-400">
            <Filter size={12}/>
            {FILTER_STARTERS.map(starter => (
              <button key={starter} onClick={() => { setQuery(starter); inputRef.current?.focus(); }} className="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700">{starter}</button>
            ))}
          </div>
        )}
        {query.trim().length >= 2 && (
          <>
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-zinc-400">Messages</div>
            {error && <p className="px-3 py-2 text-xs text-rose-600">{error}</p>}
            {!typingFilter && notes.map(note => <p key={note} className="px-3 py-1 text-xs text-amber-700">{note}</p>)}
            {!searching && !error && hits.length === 0 && (!notes.length || typingFilter) && <p className="px-3 py-2 text-xs text-zinc-400">No messages match “{query.trim()}”.</p>}
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
                    <p className="mt-0.5 line-clamp-2 text-xs text-zinc-700">{hit.snippet
                      ? <Snippet text={hit.snippet} nameOf={id => users.find(user => user.id === id)?.displayName}/>
                      : hit.message.attachments.map(file => file.fileName).join(", ")}</p>
                  </div>
                </button>
              );
            })}
            {nextCursor && <button onClick={() => void loadMore()} className="mx-auto mt-2 block rounded-md px-3 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100">More results</button>}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 border-t border-zinc-100 bg-zinc-50/60 px-4 py-2 text-[11px] text-zinc-400"><span>↑↓ navigate</span><span>Enter open</span><span>Esc close</span><span className="ml-auto hidden sm:inline">&quot;phrases&quot;, OR, -exclude, in: from: has: before: after:</span></div>
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

export type PollDraft = { question: string; options: string[]; multiSelect: boolean; anonymous: boolean; closesAt?: string };

// Opened by /poll, prefilled from its arguments. `onCreate` posts the poll and throws to show an error.
export function CreatePollDialog({ initial, onCreate, onClose }: {
  initial: Pick<PollDraft, "question" | "options">;
  onCreate: (poll: PollDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState(initial.question.slice(0, POLL_QUESTION_MAX));
  const [options, setOptions] = useState(() => {
    const given = initial.options.map(option => option.slice(0, POLL_OPTION_MAX));
    return given.length >= POLL_MIN_OPTIONS ? given : [...given, ...Array<string>(POLL_MIN_OPTIONS - given.length).fill("")];
  });
  const [multiSelect, setMultiSelect] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // With the question given, start at the first empty option; otherwise at the question.
  const [focusIndex, setFocusIndex] = useState<number | null>(() => initial.question ? options.findIndex(option => !option) : null);

  const filled = options.map(option => option.trim()).filter(Boolean);
  const duplicate = new Set(filled.map(option => option.toLowerCase())).size !== filled.length;

  function addOption() {
    if (options.length >= POLL_MAX_OPTIONS) return;
    setOptions(current => [...current, ""]);
    setFocusIndex(options.length);
  }

  // Enter in the last option adds another, like a list.
  function onOptionKey(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || index !== options.length - 1 || options.length >= POLL_MAX_OPTIONS) return;
    event.preventDefault();
    addOption();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (duplicate) { setError("Each option must be different."); return; }
    setPending(true);
    setError("");
    try {
      await onCreate({ question: question.trim(), options: filled, multiSelect, anonymous, closesAt: pollClosesAt(duration) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post the poll.");
      setPending(false);
    }
  }

  const field = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm font-normal outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-100/60";
  const toggle = "flex cursor-pointer items-center gap-2.5 text-[13px] text-zinc-700";
  return (
    <Dialog title="Create a poll" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <label className="block text-[13px] font-medium text-zinc-700">Question
          <input autoFocus={!initial.question} required maxLength={POLL_QUESTION_MAX} value={question} onChange={event => setQuestion(event.target.value)} placeholder="What should we ask?" className={cn(field, "mt-1.5")}/>
        </label>
        <fieldset>
          <legend className="text-[13px] font-medium text-zinc-700">Options</legend>
          <div className="mt-1.5 space-y-1.5">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input value={option} maxLength={POLL_OPTION_MAX} aria-label={`Option ${index + 1}`} placeholder={`Option ${index + 1}`}
                  autoFocus={focusIndex === index}
                  onChange={event => setOptions(current => current.map((value, i) => i === index ? event.target.value : value))}
                  onKeyDown={event => onOptionKey(event, index)} className={field}/>
                {options.length > POLL_MIN_OPTIONS && (
                  <button type="button" aria-label={`Remove option ${index + 1}`} onClick={() => { setOptions(current => current.filter((_, i) => i !== index)); setFocusIndex(null); }}
                    className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={14}/></button>
                )}
              </div>
            ))}
          </div>
          {options.length < POLL_MAX_OPTIONS && (
            <button type="button" onClick={addOption} className="mt-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-brand-600 transition hover:bg-brand-50"><Plus size={13}/>Add option</button>
          )}
        </fieldset>
        <div className="space-y-2.5 rounded-lg border border-zinc-200 p-3">
          <label className={toggle}><input type="checkbox" checked={multiSelect} onChange={event => setMultiSelect(event.target.checked)} className="accent-brand-600"/>Let people choose more than one option</label>
          <label className={toggle}><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} className="accent-brand-600"/>Anonymous: hide who voted for what</label>
          <label className={toggle}>Close the poll
            <select value={duration} onChange={event => setDuration(Number(event.target.value))} className="ml-auto rounded-md border border-zinc-200 bg-card px-2 py-1 text-xs outline-none focus:border-brand-300">
              {POLL_DURATIONS.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}
            </select>
          </label>
        </div>
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !question.trim() || filled.length < POLL_MIN_OPTIONS}>{pending ? "Posting…" : "Post poll"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// A channel, or a person (whose DM may not exist yet).
export type ForwardTarget = { kind: "conversation"; id: string } | { kind: "person"; userId: string };
const MAX_FORWARD_TARGETS = 10;

// What the forward will quote: the message itself, or the original if it is a bare forward (the server does
// the same, so cards never nest).
function quotedForward(message: ChatMessage, conversation: ConversationSummary | undefined): ChatForward {
  if (message.forwarded && !message.body && !message.attachments.length) return message.forwarded;
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    parentId: message.parentId,
    conversation: { type: conversation?.type ?? "CHANNEL", isPrivate: conversation?.isPrivate ?? true, name: conversation && !conversation.isPrivate ? conversation.name : null },
    author: message.author,
    body: message.body,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    deleted: false,
    attachments: message.attachments,
    // Forwarded copies show results without who voted, as the server does.
    poll: message.poll && { ...message.poll, myVotes: null, options: message.poll.options.map(option => ({ ...option, userIds: [] })) }
  };
}

// Forward (share) a message to channels and people, with an optional comment.
export function ForwardDialog({ message, conversations, users, me, usersById, label, onForward, onClose }: {
  message: ChatMessage;
  conversations: ConversationSummary[];
  users: ChatUser[];
  me: ChatUser;
  usersById: Map<string, ChatUser>;
  label: (conversation: ConversationSummary) => string;
  onForward: (targets: ForwardTarget[], comment: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);

  const quoted = useMemo(() => quotedForward(message, conversations.find(c => c.id === message.conversationId)), [message, conversations]);
  const options = useMemo(() => {
    const dmByPartner = new Map(conversations.filter(c => c.type === "DM").map(c => [c.memberIds.find(id => id !== me.id) ?? me.id, c]));
    return [
      // Only channels the user is in and can post to.
      ...conversations.filter(c => c.type === "CHANNEL" && c.isMember && !c.archivedAt).sort((a, b) => a.name.localeCompare(b.name)).map(c => ({
        key: c.id, label: c.name, chip: `#${c.name}`, search: c.name, icon: c.isPrivate ? <Lock size={14}/> : <Hash size={14}/>, target: { kind: "conversation", id: c.id } as ForwardTarget
      })),
      ...[...users].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || a.displayName.localeCompare(b.displayName)).map(user => {
        const dm = dmByPartner.get(user.id);
        return {
          key: dm?.id ?? `person:${user.id}`, label: user.id === me.id ? `${user.displayName} (you)` : user.displayName, chip: user.displayName, search: user.displayName.toLowerCase(),
          icon: <Avatar name={user.displayName} color={user.avatarColor} size="sm"/>,
          target: (dm ? { kind: "conversation", id: dm.id } : { kind: "person", userId: user.id }) as ForwardTarget
        };
      })
    ];
  }, [conversations, users, me.id]);
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  const visible = options.filter(option => option.search.includes(q));
  const picked = selected.flatMap(key => options.find(option => option.key === key) ?? []);
  // Sharing out of a private channel or DM shows it to people who may not be in it.
  const leavesPrivate = quoted.conversation.type === "DM" || quoted.conversation.isPrivate
    ? picked.some(option => option.target.kind === "person" || option.target.id !== quoted.conversationId)
    : false;

  function toggle(key: string) {
    setSelected(current => current.includes(key) ? current.filter(item => item !== key) : current.length < MAX_FORWARD_TARGETS ? [...current, key] : current);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!picked.length || pending) return;
    setPending(true);
    try {
      if (await onForward(picked.map(option => option.target), comment.trim())) onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog title="Forward message" onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="space-y-4 p-5">
        <div>
          <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1.5 transition focus-within:border-brand-300 focus-within:ring-4 focus-within:ring-brand-100/60">
            {picked.map(option => (
              <span key={option.key} className="flex items-center gap-1 rounded-md bg-brand-50 py-0.5 pl-1.5 pr-0.5 text-xs font-medium text-brand-700">
                {option.chip}
                <button type="button" onClick={() => toggle(option.key)} aria-label={`Remove ${option.label}`} className="rounded p-0.5 text-brand-400 transition hover:bg-brand-100 hover:text-brand-700"><X size={11}/></button>
              </span>
            ))}
            <input autoFocus value={query} onChange={event => setQuery(event.target.value)} aria-label="Search channels and people"
              onKeyDown={event => {
                if (event.key === "Enter") { event.preventDefault(); if (visible[0]) { toggle(visible[0].key); setQuery(""); } }
                if (event.key === "Backspace" && !query && selected.length) setSelected(current => current.slice(0, -1));
              }}
              placeholder={picked.length ? "" : "Add channels or people"} className="min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-zinc-400"/>
          </div>
          <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-200 p-1.5">
            {visible.map(option => {
              const on = selected.includes(option.key);
              return (
                <button type="button" key={option.key} onClick={() => toggle(option.key)} disabled={!on && selected.length >= MAX_FORWARD_TARGETS}
                  className={cn("flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition disabled:opacity-40", on ? "bg-brand-50 text-brand-800" : "text-zinc-700 hover:bg-zinc-50")}>
                  <span className="text-zinc-400">{option.icon}</span><span className="truncate">{option.label}</span>
                  {on && <Check size={14} className="ml-auto text-brand-600"/>}
                </button>
              );
            })}
            {visible.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-400">No channels or people match “{query.trim()}”.</p>}
          </div>
        </div>
        <label className="block text-[13px] font-medium text-zinc-700">Add a message <span className="font-normal text-zinc-400">(optional)</span>
          <textarea value={comment} onChange={event => setComment(event.target.value)} rows={2} maxLength={4000}
            onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }}
            className="mt-1.5 w-full resize-y rounded-lg border border-zinc-200 px-3 py-2 text-sm font-normal outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-100/60"/>
        </label>
        <ForwardedCard forward={quoted} usersById={usersById} me={me}/>
        {leavesPrivate && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800">
            <ShieldAlert size={14} className="mt-px shrink-0"/>This message is from {forwardSourceLabel(quoted)}. Everyone where you forward it will be able to read it and open its files.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <span className="mr-auto text-[11px] text-zinc-400">{picked.length ? `${picked.length} of ${MAX_FORWARD_TARGETS}` : "Pick up to 10"}</span>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !picked.length}>{pending ? "Forwarding…" : "Forward"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘ K / Ctrl K", "Jump to a conversation or search messages"],
  ["Enter", "Send message"],
  ["Shift + Enter", "New line"],
  ["↑", "Edit your last message (in an empty message box)"],
  ["⌥ ↑ / Alt ↑", "Previous conversation in the sidebar"],
  ["⌥ ↓ / Alt ↓", "Next conversation in the sidebar"],
  ["Esc", "Mark the conversation read, or close a dialog, menu or edit"],
  ["⌘ / / Ctrl /", "Show this help"]
];

const COMMANDS: [string, string][] = [
  // ["/giphy cats", "Pick a GIF to post (Send, Shuffle or Cancel)"],
  ["/remind me to stretch in 20 minutes", "Also \"at 3pm\", \"tomorrow at 9am\", \"on friday\""],
  ["/remind list", "Open your reminders (also under Reminders in the sidebar). To be reminded about a message, choose the alarm clock on it"],
  ["/status 🌴 On vacation", "Set your status; /status clear removes it"],
  ["/poll", "Create a poll: one or several choices, anonymous, closing time"]
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
        <div>
          <h3 className="mb-1 text-[11px] font-medium text-zinc-400">Slash commands</h3>
          <table className="w-full"><tbody>
            {COMMANDS.map(([example, action]) => (
              <tr key={example} className="border-b border-zinc-100 last:border-0"><td className="py-2 pr-4"><code className="whitespace-nowrap rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700">{example}</code></td><td className="py-2">{action}</td></tr>
            ))}
          </tbody></table>
        </div>
        <ul className="list-disc space-y-1.5 pl-4 leading-5">
          <li>Hover a message to react, reply in a thread, forward, edit or delete it.</li>
          <li>Type <b>@</b> (or use the @ button) to mention someone; mentions appear in their Activity.</li>
          <li>Drop or paste files into the composer. Files are scanned for malware before anyone can download them.</li>
          <li>To send a message that starts with <b>/</b>, start it with <b>//</b>.</li>
          <li>Format with <b>**bold**</b>, <i>*italic*</i>, <code className="font-mono">`code`</code>, <code className="font-mono">```</code> code blocks (add a language, like <code className="font-mono">```js</code>), <b>&gt;</b> quotes and <b>-</b> or <b>1.</b> lists. Put <b>\</b> before a symbol to type it as is.</li>
          <li>Search matches the start of words, and supports <b>"exact phrases"</b>, <b>OR</b> and <b>-excluded</b> words.</li>
          <li>Narrow a search with <b>in:#channel</b>, <b>in:@person</b> (your DM), <b>from:@person</b>, <b>from:me</b>, <b>has:file</b>, <b>has:link</b> and <b>before:</b>, <b>after:</b> or <b>on:</b> a date (YYYY-MM-DD, today, yesterday).</li>
        </ul>
      </div>
    </Dialog>
  );
}

const THEME_MODES: { mode: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { mode: "light", label: "Light", icon: <Sun size={13}/> },
  { mode: "system", label: "System", icon: <Monitor size={13}/> },
  { mode: "dark", label: "Dark", icon: <Moon size={13}/> }
];

// Light / dark / follow the OS, plus the accent hue. Saved in this browser.
function AppearancePicker() {
  const { mode, accent, setPrefs } = useTheme();
  return (
    <div className="border-b border-zinc-100 px-2.5 py-2.5">
      <div className="text-[11px] font-medium text-zinc-400">Appearance</div>
      <div role="radiogroup" aria-label="Color theme" className="mt-1.5 grid grid-cols-3 gap-0.5 rounded-lg bg-zinc-100 p-0.5">
        {THEME_MODES.map(option => (
          <button key={option.mode} role="radio" aria-checked={mode === option.mode} onClick={() => setPrefs({ mode: option.mode })}
            className={cn("flex h-7 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition", mode === option.mode ? "bg-card text-zinc-900 shadow-float" : "text-zinc-500 hover:text-zinc-800")}>
            {option.icon}{option.label}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Accent color" className="mt-2.5 flex items-center gap-2">
        {ACCENTS.map(option => (
          <button key={option.id} role="radio" aria-checked={accent === option.id} aria-label={option.label} title={option.label} onClick={() => setPrefs({ accent: option.id })}
            style={{ backgroundColor: `hsl(${option.hue} 55% 52%)` }}
            className={cn("flex h-5 w-5 items-center justify-center rounded-full text-white transition", accent === option.id ? "ring-2 ring-zinc-900/80 ring-offset-2 ring-offset-card" : "hover:scale-110")}>
            {accent === option.id && <Check size={11} strokeWidth={3}/>}
          </button>
        ))}
      </div>
    </div>
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
      <AppearancePicker/>
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
