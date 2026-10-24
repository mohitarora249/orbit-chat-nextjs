"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlarmClock, Archive, AtSign, Bell, CalendarClock, CheckCheck, ChevronDown, Compass, Hash, HelpCircle, Loader2, Lock, LogOut, Menu, Pencil, Pin, Plus, Search, Users, X
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { ActivityPanel, PeoplePanel, ReminderSubject, RemindersPanel, ScheduledPanel, ThreadPanel, type ThreadState } from "@/components/chat/panels";
import { CommandPalette, CreateChannelDialog, CreatePollDialog, ForwardDialog, HelpDialog, NotificationsMenu, WorkspaceMenu, type ForwardTarget, type NotificationPrefs, type PollDraft } from "@/components/chat/dialogs";
import { StatusMenu, type StatusPatch } from "@/components/chat/status-menu";
import { BrowseChannelsDialog, ChannelDetailsDialog, channelPermissions, type ChannelTab } from "@/components/chat/channels";
import { compareMessages, conversationLabel, dayLabel, dmPartnerId, isGrouped, isOptimistic, keepMyVotes, keepUnsent, mergeMessages, timeLabel, upsertMessage } from "@/components/chat/helpers";
import { applyOps, failureText, opKey, opsByMessage, outgoing, withOps, type MessageOp, type OpChange, type PendingOps } from "@/components/chat/pending";
import { queueSend, queuedSends, unqueueSends } from "@/components/chat/offline-queue";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { parsePollArgs, parseReminder, parseStatus, reminderTimeLabel, type SlashCommandName } from "@/lib/commands";
import { isGifUrl } from "@/lib/links";
import { markdownToText } from "@/lib/markdown";
import { encodeMentions, mentionsMe, mentionsToText, mentionTargets } from "@/lib/mentions";
import { customStatus, IDLE_AFTER_MS, isDnd, presenceLabels, untilLabel, type Presence, type UserStatus } from "@/lib/presence";
import { playSound, primeSounds } from "@/lib/sounds";
import { cn } from "@/lib/utils";
import type { ActivityItem, Bootstrap, ChannelMember, ChatAttachment, ChatForward, ChatMessage, ChatReminder, ChatScheduledMessage, ChatUser, ConversationDetails, ConversationSummary, Draft, MessageAction, MessagePage, SearchHit } from "@/lib/types";

type History = { messages: ChatMessage[]; nextCursor: string | null; loaded: boolean };
type TypingState = Record<string, Record<string, { name: string; until: number }>>;
type RightPanel = "thread" | "activity" | "people" | "reminders" | "scheduled" | null;
type MentionToast = { message: ChatMessage; kind: NonNullable<ReturnType<typeof mentionsMe>>; where: string };
// A message ↑ asked to edit, in the main list or the open thread (a thread's parent is in both).
type EditRequest = { id: string; where: "main" | "thread" };

const PAGE_SIZE = 50;
const TYPING_TTL_MS = 6000;
const MENTION_TOAST_MS = 8000;
// How often to re-check idleness and re-render for statuses that expire.
const PRESENCE_TICK_MS = 30 * 1000;
// When jumping to an old search result, give up after this many pages of history.
const MAX_JUMP_PAGES = 10;
const SNOOZE_MS = 20 * 60 * 1000;
const emptyHistory: History = { messages: [], nextCursor: null, loaded: false };

const typingKey = (conversationId: string, parentId?: string | null) => `${conversationId}|${parentId ?? ""}`;

// Adds, replaces (reminder) or removes (null) a reminder, keeping the list soonest first.
function upsertReminder(list: ChatReminder[], reminderId: string, reminder: ChatReminder | null) {
  const rest = list.filter(item => item.id !== reminderId);
  return reminder ? [...rest, reminder].sort((a, b) => a.remindAt.localeCompare(b.remindAt) || a.id.localeCompare(b.id)) : rest;
}

// Like upsertReminder, for scheduled messages (null once sent or deleted).
function upsertScheduled(list: ChatScheduledMessage[], scheduledMessageId: string, scheduled: ChatScheduledMessage | null) {
  const rest = list.filter(item => item.id !== scheduledMessageId);
  return scheduled ? [...rest, scheduled].sort((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id)) : rest;
}

// The newest of my messages that ↑ can edit: not pending, deleted or a GIF.
function lastEditable(messages: ChatMessage[], meId: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.authorId === meId && !message.deletedAt && !isOptimistic(message) && !isGifUrl(message.body)) return i;
  }
  return -1;
}

// DMs, and channels the user has joined that are not archived. Other public channels can be browsed and
// previewed, but do not show in the sidebar, count towards mentions or notify.
const inSidebar = (conversation: ConversationSummary) => conversation.type === "DM" || (conversation.isMember && !conversation.archivedAt);

function readPrefs(userId: string): NotificationPrefs {
  try {
    const raw = localStorage.getItem(`orbit-chat-notify:${userId}`);
    if (raw) return { desktop: false, sound: true, muted: [], ...JSON.parse(raw) };
  } catch {
    // Storage can be unavailable (private mode); fall back to defaults.
  }
  return { desktop: false, sound: true, muted: [] };
}

export function ChatApp() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unreadMarker, setUnreadMarker] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  // Channels and DMs pinned to the top of the sidebar, in pin order (personal).
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  // Unsent composer text by conversation id (personal, synced to the server).
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [dialog, setDialog] = useState<"palette" | "create" | "help" | "browse" | "details" | null>(null);
  // A poll being written, opened by /poll in the conversation (or thread) it will be posted to.
  const [pollDraft, setPollDraft] = useState<{ conversationId: string; parentId: string | null; question: string; options: string[] } | null>(null);
  const [detailsTab, setDetailsTab] = useState<ChannelTab>("about");
  const [menu, setMenu] = useState<"workspace" | "notifications" | "status" | null>(null);
  // Other people's presence; ours is derived from the socket and `idle`.
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [idle, setIdle] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [typing, setTyping] = useState<TypingState>({});
  const [socketConnected, setSocketConnected] = useState(false);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [showSidebar, setShowSidebar] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs>({ desktop: false, sound: true, muted: [] });
  const [visibleTick, setVisibleTick] = useState(0);
  const [mentionToast, setMentionToast] = useState<MentionToast | null>(null);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  // My reminders that are not done: gone off (firedAt set) or waiting, soonest first.
  const [reminders, setReminders] = useState<ChatReminder[]>([]);
  // My messages waiting to be sent, or that failed to send, soonest first.
  const [scheduled, setScheduled] = useState<ChatScheduledMessage[]>([]);
  // Sends, reactions, edits and deletes shown before the server confirms them, or that failed (see pending.ts).
  const [ops, setOps] = useState<PendingOps>({});

  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Socket handlers and in-flight requests outlive renders, so they read current values from refs.
  const activeIdRef = useRef<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const bootstrapRef = useRef<Bootstrap | null>(null);
  const prefsRef = useRef(prefs);
  const idleRef = useRef(false);
  const lastMarkedRef = useRef("");
  const jumpPagesRef = useRef(0);
  // Draft saves still in flight, by conversation. Their responses are applied in order; draft:update events
  // for those conversations are ignored meanwhile, since they may describe an older save.
  const draftSavesRef = useRef(new Map<string, { count: number; queue: Promise<void> }>());
  const jumpToRef = useRef<(conversationId: string, messageId: string, parentId: string | null) => void>(() => {});
  // Conversation ids in sidebar order, for Alt+↑/↓.
  const sidebarOrderRef = useRef<string[]>([]);
  // A dialog or menu is open: it handles Esc and arrow keys itself.
  const overlayOpenRef = useRef(false);
  const remindersRef = useRef(reminders);
  const scheduledRef = useRef(scheduled);
  const opsRef = useRef(ops);
  const opSeqRef = useRef(0);
  // Sends go out one at a time, so messages arrive in the order they were written.
  const sendQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  bootstrapRef.current = bootstrap;
  opsRef.current = ops;
  remindersRef.current = reminders;
  scheduledRef.current = scheduled;
  overlayOpenRef.current = dialog !== null || menu !== null || forwarding !== null || pollDraft !== null;
  prefsRef.current = prefs;
  idleRef.current = idle;
  threadIdRef.current = thread?.parentId ?? null;

  const me = bootstrap?.me ?? null;
  const meId = me?.id;
  const usersById = useMemo(() => new Map((bootstrap?.users ?? []).map(user => [user.id, user])), [bootstrap?.users]);
  const label = useCallback((conversation: ConversationSummary) => conversationLabel(conversation, me?.id ?? "", usersById), [me?.id, usersById]);
  const activeConversation = useMemo(() => bootstrap?.conversations.find(c => c.id === activeId) ?? null, [bootstrap, activeId]);
  const canModerate = bootstrap?.workspace.role === "OWNER" || bootstrap?.workspace.role === "ADMIN";

  const updateConversation = useCallback((id: string, update: (conversation: ConversationSummary) => ConversationSummary) => {
    setBootstrap(current => current && { ...current, conversations: current.conversations.map(c => c.id === id ? update(c) : c) });
  }, []);

  const applyDetails = useCallback((details: Partial<ConversationDetails> & { id: string }) => {
    updateConversation(details.id, conversation => ({ ...conversation, ...details }));
  }, [updateConversation]);

  // Left or removed from a private channel: it is gone. The effect below moves off it if it was open.
  const removeConversation = useCallback((id: string) => {
    setBootstrap(current => current && { ...current, conversations: current.conversations.filter(c => c.id !== id) });
  }, []);

  const addConversation = useCallback((conversation: ConversationSummary) => {
    setBootstrap(current => current && !current.conversations.some(c => c.id === conversation.id)
      ? { ...current, conversations: [...current.conversations, conversation] }
      : current);
  }, []);

  const setStatus = useCallback((userId: string, status: UserStatus | null) => {
    setBootstrap(current => {
      if (!current) return current;
      const { [userId]: _previous, ...rest } = current.statuses;
      return { ...current, statuses: status ? { ...rest, [userId]: status } : rest };
    });
  }, []);

  // ---- Loading -------------------------------------------------------------------------------------------

  const loadBootstrap = useCallback(async () => {
    setLoadError("");
    try {
      const data = await api<Bootstrap>("/api/bootstrap");
      setBootstrap(data);
      setPinnedIds(data.pinnedConversationIds);
      setDrafts(data.drafts);
      setReminders(data.reminders);
      setScheduled(data.scheduledMessages);
      setPrefs(readPrefs(data.me.id));
      let last: string | null = null;
      try { last = localStorage.getItem(`orbit-chat-last:${data.me.id}`); } catch { /* storage unavailable */ }
      setActiveId(current => {
        const candidates = [current, last];
        return candidates.find(id => id && data.conversations.some(c => c.id === id))
          ?? data.conversations.find(c => c.type === "CHANNEL")?.id ?? data.conversations[0]?.id ?? null;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not connect to the server.");
    }
  }, []);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations, pinnedConversationIds, drafts } = await api<{ conversations: ConversationSummary[]; pinnedConversationIds: string[]; drafts: Record<string, Draft> }>("/api/conversations");
      setBootstrap(current => current && { ...current, conversations });
      setPinnedIds(pinnedConversationIds);
      // Drafts with a save in flight keep the local text; the save's response settles them.
      setDrafts(current => {
        const next = { ...drafts };
        for (const id of draftSavesRef.current.keys()) {
          if (current[id]) next[id] = current[id];
          else delete next[id];
        }
        return next;
      });
    } catch {
      // Keep the current list; the next reconnect or reload retries.
    }
  }, []);

  const setDraft = useCallback((conversationId: string, draft: Draft | null) => {
    setDrafts(current => {
      const { [conversationId]: _previous, ...rest } = current;
      return draft ? { ...rest, [conversationId]: draft } : rest;
    });
  }, []);

  // Shown locally at once; saves for one conversation go out one at a time, so the last one typed wins.
  const saveDraft = useCallback((conversationId: string, body: string) => {
    setDraft(conversationId, body.trim() ? { body, updatedAt: new Date().toISOString() } : null);
    const saves = draftSavesRef.current;
    const entry = saves.get(conversationId) ?? { count: 0, queue: Promise.resolve() };
    entry.count += 1;
    entry.queue = entry.queue.then(async () => {
      try {
        const { draft } = await api<{ draft: Draft | null }>(`/api/conversations/${conversationId}/draft`, { method: "PUT", json: { body } });
        if (entry.count === 1) setDraft(conversationId, draft);
      } catch {
        // Keep the local copy: it is still in this tab, and the next edit saves it again.
      } finally {
        entry.count -= 1;
        if (!entry.count) saves.delete(conversationId);
      }
    });
    saves.set(conversationId, entry);
  }, [setDraft]);

  // My messages the server has, by clientMessageId: their sends are done, even if the request itself failed
  // after the message was saved.
  const confirmSends = useCallback((messages: ChatMessage[]) => {
    const done = new Set(messages.map(message => `send:${message.clientMessageId}`));
    void unqueueSends(Object.values(opsRef.current).flatMap(op => op.kind === "send" && done.has(op.key) ? [op.message.clientMessageId] : []));
    setOps(current => Object.keys(current).some(key => done.has(key))
      ? Object.fromEntries(Object.entries(current).filter(([key]) => !done.has(key)))
      : current);
  }, []);

  const fetchPage = useCallback((conversationId: string, options: { cursor?: string | null; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (options.cursor) params.set("cursor", options.cursor);
    return api<MessagePage>(`/api/conversations/${conversationId}/messages?${params}`, { signal: options.signal });
  }, []);

  // Loads the newest page and merges it with what we already have. `catchUp` is used after a reconnect: if the
  // page overlaps the loaded history, older pages the user scrolled back through are kept. Within the page's
  // range the server is authoritative, which also drops messages that were deleted while we were offline.
  const loadMessages = useCallback(async (conversationId: string, options: { catchUp?: boolean; signal?: AbortSignal } = {}) => {
    try {
      const page = await fetchPage(conversationId, { signal: options.signal });
      // A slow response for a conversation the user has already left must not overwrite the current one.
      if (activeIdRef.current !== conversationId) return;
      confirmSends(page.messages);
      setHistory(current => {
        const own = current.messages.filter(message => message.conversationId === conversationId);
        const confirmed = own.filter(message => !isOptimistic(message));
        const pending = own.filter(message => isOptimistic(message) && !page.messages.some(item => item.clientMessageId === message.clientMessageId));
        const known = new Set(confirmed.map(message => message.id));
        const contiguous = page.messages.some(message => known.has(message.id));
        const oldest = page.messages[0];
        const older = contiguous && oldest ? confirmed.filter(message => compareMessages(message, oldest) < 0) : [];
        return {
          messages: [...mergeMessages(older, page.messages), ...pending],
          nextCursor: options.catchUp && contiguous ? current.nextCursor : page.nextCursor,
          loaded: true
        };
      });
    } catch (error) {
      if (options.signal?.aborted || activeIdRef.current !== conversationId) return;
      setNotice(error instanceof Error ? error.message : "Unable to load messages.");
    }
  }, [fetchPage, confirmSends]);

  const loadOlder = useCallback(async () => {
    const conversationId = activeIdRef.current;
    if (!conversationId || !history.nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(conversationId, { cursor: history.nextCursor });
      if (activeIdRef.current !== conversationId) return;
      setHistory(current => ({
        messages: [...mergeMessages(page.messages, current.messages.filter(message => !isOptimistic(message))), ...current.messages.filter(isOptimistic)],
        nextCursor: page.nextCursor,
        loaded: true
      }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load older messages.");
    } finally {
      setLoadingOlder(false);
    }
  }, [fetchPage, history.nextCursor, loadingOlder]);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (!activeId) return;
    const controller = new AbortController();
    // Unsent messages are kept across conversation switches; loadMessages keeps them after the newest page.
    setHistory({ ...emptyHistory, messages: outgoing(opsRef.current, activeId, null) });
    jumpPagesRef.current = 0;
    setUnreadMarker(bootstrapRef.current?.conversations.find(c => c.id === activeId)?.lastReadAt ?? null);
    void loadMessages(activeId, { signal: controller.signal });
    try { if (bootstrapRef.current) localStorage.setItem(`orbit-chat-last:${bootstrapRef.current.me.id}`, activeId); } catch { /* storage unavailable */ }
    return () => controller.abort();
  }, [activeId, loadMessages]);

  // The open conversation can disappear (removed from a private channel, here or in another tab).
  useEffect(() => {
    if (!bootstrap || !activeId || bootstrap.conversations.some(c => c.id === activeId)) return;
    setActiveId(bootstrap.conversations.find(c => c.type === "CHANNEL" && inSidebar(c))?.id ?? bootstrap.conversations[0]?.id ?? null);
    setThread(null);
    setRightPanel(current => current === "thread" ? null : current);
    setDialog(current => current === "details" ? null : current);
  }, [bootstrap, activeId]);

  // Only the rows near the viewport are mounted, so long channels stay smooth. Row 0 is the header (older-page
  // spinner, channel intro); every other row is one message with its day divider, unread line and "Seen".
  // Anchoring to the end keeps the reader's place when older pages are prepended or rows above resize, and
  // follows new messages while the reader is at the bottom.
  const opsForMessage = useMemo(() => opsByMessage(ops), [ops]);
  const messages = useMemo(() => meId ? applyOps(history.messages, opsForMessage, meId) : history.messages, [history.messages, opsForMessage, meId]);
  const shownThread = useMemo(() => thread && meId ? {
    ...thread,
    parent: thread.parent && withOps(thread.parent, opsForMessage.get(thread.parent.id), meId),
    replies: applyOps(thread.replies, opsForMessage, meId)
  } : thread, [thread, opsForMessage, meId]);
  const getRowKey = useCallback((index: number) => index === 0 ? "header" : messages[index - 1].id, [messages]);
  const virtualizer = useVirtualizer({
    count: messages.length + 1,
    getScrollElement: () => scrollRef.current,
    getItemKey: getRowKey,
    estimateSize: index => index === 0 ? 0 : 64,
    overscan: 8,
    paddingStart: 24,
    paddingEnd: 24,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 120
  });
  const virtualRows = virtualizer.getVirtualItems();

  // Infinite scroll: load the previous page when the header row is near the viewport. The live scrollTop check
  // skips the first render of a page, whose range is computed before it is scrolled to the bottom.
  const nearTop = virtualRows[0]?.index === 0;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (nearTop && history.loaded && scroller && scroller.scrollTop < 400) void loadOlder();
    // Runs again after each page, so short pages on tall screens keep loading until the view can scroll.
  }, [nearTop, history.loaded, history.nextCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Messages I send jump to the bottom even when I had scrolled up.
  const lastMessage = history.messages[history.messages.length - 1];
  useLayoutEffect(() => {
    if (lastMessage && lastMessage.authorId === me?.id) virtualizer.scrollToEnd();
  }, [lastMessage?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Read state ----------------------------------------------------------------------------------------

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") setVisibleTick(tick => tick + 1); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!activeId || !history.loaded || document.visibilityState !== "visible") return;
    const latest = [...history.messages].reverse().find(message => !isOptimistic(message));
    const conversation = bootstrapRef.current?.conversations.find(c => c.id === activeId);
    if (!latest || !conversation) return;
    const upToDate = conversation.unreadCount === 0 && conversation.mentionCount === 0 && conversation.lastReadAt !== null && conversation.lastReadAt >= latest.createdAt;
    const key = `${activeId}:${latest.id}`;
    if (upToDate || lastMarkedRef.current === key) return;
    lastMarkedRef.current = key;
    updateConversation(activeId, c => ({ ...c, unreadCount: 0, mentionCount: 0, lastReadAt: latest.createdAt }));
    api(`/api/conversations/${activeId}/read`, { method: "POST", json: { messageId: latest.id } }).catch(() => { lastMarkedRef.current = ""; });
  }, [activeId, history, visibleTick, updateConversation]);

  // ---- Message mutations (shared by socket events and local responses) ------------------------------------

  const applyUpdated = useCallback((message: ChatMessage) => {
    // A deleted message with no thread disappears, matching what the history API returns.
    const remove = Boolean(message.deletedAt) && message.replyCount === 0;
    const apply = (list: ChatMessage[]) => remove ? list.filter(item => item.id !== message.id) : list.map(item => item.id === message.id ? keepMyVotes(item, message) : item);
    if (!message.parentId) setHistory(current => ({ ...current, messages: apply(current.messages) }));
    setThread(current => {
      if (!current) return current;
      if (current.parentId === message.id) return { ...current, parent: current.parent ? keepMyVotes(current.parent, message) : message };
      return message.parentId === current.parentId ? { ...current, replies: apply(current.replies) } : current;
    });
  }, []);


  const notify = useCallback((message: ChatMessage) => {
    const state = bootstrapRef.current;
    const current = prefsRef.current;
    if (!state || message.authorId === state.me.id || !current.desktop || current.muted.includes(message.conversationId) || isDnd(state.statuses[state.me.id])) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && message.conversationId === activeIdRef.current) return;
    const conversation = state.conversations.find(c => c.id === message.conversationId);
    if (conversation && !inSidebar(conversation)) return;
    if (!mentionsMe(message.body, state.me.id) && conversation?.type !== "DM") return;
    const where = conversation?.type === "DM" ? "" : ` in #${conversation?.name ?? "a channel"}`;
    const body = mentionsToText(markdownToText(message.body), id => state.users.find(user => user.id === id)?.displayName);
    const notification = new Notification(`${message.author.displayName}${where}`, { body: body || (message.forwarded ? "Forwarded a message" : "Sent an attachment"), tag: message.id });
    notification.onclick = () => {
      window.focus();
      setActiveId(message.conversationId);
      notification.close();
    };
  }, []);

  // A reminder going off sounds like a mention and shows a desktop notification when enabled, unless notifications are paused.
  const alertReminder = useCallback((reminder: ChatReminder) => {
    const state = bootstrapRef.current;
    const current = prefsRef.current;
    if (!state || isDnd(state.statuses[state.me.id])) return;
    if (current.sound) playSound("mention");
    if (!current.desktop || typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
    const about = reminder.message && !reminder.message.deleted ? mentionsToText(markdownToText(reminder.message.body), id => state.users.find(user => user.id === id)?.displayName) : "";
    const notification = new Notification("Reminder", { body: reminder.text || about || "About a message", tag: `reminder-${reminder.id}` });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }, []);

  const handleNew = useCallback((message: ChatMessage) => {
    const state = bootstrapRef.current;
    setTyping(current => {
      const key = typingKey(message.conversationId, message.parentId);
      if (!current[key]?.[message.authorId]) return current;
      const { [message.authorId]: _removed, ...rest } = current[key];
      return { ...current, [key]: rest };
    });
    const conversation = state?.conversations.find(c => c.id === message.conversationId);
    // Public channels the user has not joined (or archived ones) stay quiet; they still update if open.
    const fromOther = Boolean(state) && message.authorId !== state?.me.id && (!conversation || inSidebar(conversation));
    // Any mention alerts live. @here only reaches people who are online and not away.
    const kind = fromOther ? mentionsMe(message.body, state!.me.id) : null;
    const mention = kind === "here" && idleRef.current ? null : kind;
    const dnd = isDnd(state?.statuses[state.me.id]);
    // "Seeing it" means the message landed in what is on screen right now: the open thread for a reply,
    // the open conversation for a top-level message.
    const seeing = document.visibilityState === "visible" && (message.parentId
      ? threadIdRef.current === message.parentId
      : message.conversationId === activeIdRef.current);
    if (state && message.authorId === state.me.id) confirmSends([message]);
    if (message.parentId) {
      setThread(current => current && current.parentId === message.parentId ? { ...current, replies: upsertMessage(current.replies, message) } : current);
      if (mention && !seeing) updateConversation(message.conversationId, c => ({ ...c, mentionCount: c.mentionCount + 1 }));
    } else {
      const viewing = message.conversationId === activeIdRef.current;
      if (viewing) setHistory(current => ({ ...current, messages: upsertMessage(current.messages, message) }));
      const counts = fromOther && !seeing;
      updateConversation(message.conversationId, c => ({
        ...c,
        unreadCount: counts ? c.unreadCount + 1 : c.unreadCount,
        mentionCount: counts && mention ? c.mentionCount + 1 : c.mentionCount,
        lastMessage: { body: message.body, createdAt: message.createdAt, author: { displayName: message.author.displayName } }
      }));
    }
    if (mention && !seeing && !dnd && !message.id.startsWith("optimistic-")) {
      const where = conversation?.type === "DM" ? "a direct message" : `#${conversation?.name ?? "a channel"}`;
      setMentionToast({ message, kind: mention, where: message.parentId ? `a thread in ${where}` : where });
    }
    if (fromOther && !seeing && !dnd && !message.id.startsWith("optimistic-") && prefsRef.current.sound && !prefsRef.current.muted.includes(message.conversationId)) {
      playSound(mention || conversation?.type === "DM" ? "mention" : "message");
    }
    notify(message);
  }, [notify, updateConversation, confirmSends]);

  useEffect(() => primeSounds(), []);

  // ---- Unconfirmed changes (see pending.ts) ---------------------------------------------------------------

  // Adds (or confirms) a message in the open conversation or thread.
  const placeMessage = useCallback((message: ChatMessage) => {
    if (message.parentId) setThread(current => current?.parentId === message.parentId ? { ...current, replies: upsertMessage(current.replies, message) } : current);
    else if (activeIdRef.current === message.conversationId) setHistory(current => ({ ...current, messages: upsertMessage(current.messages, message) }));
  }, []);

  const dropMessage = useCallback((clientMessageId: string) => {
    const drop = (list: ChatMessage[]) => list.filter(item => item.clientMessageId !== clientMessageId);
    setHistory(current => ({ ...current, messages: drop(current.messages) }));
    setThread(current => current && { ...current, replies: drop(current.replies) });
  }, []);

  const opRequest = useCallback((change: OpChange) => {
    if (change.kind === "send") {
      const { conversationId, clientMessageId, body, parentId, attachments } = change.message;
      const run = sendQueueRef.current.then(() => api<{ message: ChatMessage }>(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        // clientMessageId makes this idempotent, so a retry never posts the message twice.
        json: { body, clientMessageId, parentId: parentId ?? undefined, attachmentIds: attachments.map(attachment => attachment.id) }
      }));
      sendQueueRef.current = run.catch(() => undefined);
      return run;
    }
    if (change.kind === "react") return api<{ message: ChatMessage }>(`/api/messages/${change.messageId}/reactions`, { method: change.add ? "PUT" : "DELETE", json: { emoji: change.emoji } });
    if (change.kind === "edit") return api<{ message: ChatMessage }>(`/api/messages/${change.messageId}`, { method: "PATCH", json: { body: change.body } });
    if (change.kind === "vote") return api<{ message: ChatMessage }>(`/api/messages/${change.messageId}/actions`, { method: "POST", json: { action: "poll.vote", optionIds: change.optionIds } });
    return api<{ message: ChatMessage }>(`/api/messages/${change.messageId}`, { method: "DELETE" });
  }, []);

  // Shows a change at once and sends it. The server's copy replaces the op when it answers; on failure the op
  // stays, marked failed, so the message can offer to retry. A newer change of the same kind replaces an op,
  // and the replaced request's answer is then ignored. Sends are also queued in IndexedDB until the server has
  // them, and one that can't reach the server stays pending, waiting to be replayed (see offline-queue.ts).
  const runOp = useCallback(async (change: OpChange) => {
    const key = opKey(change);
    const seq = ++opSeqRef.current;
    const op = { ...change, key, seq, status: "pending", error: null, network: false } as MessageOp;
    setOps(current => ({ ...current, [key]: op }));
    if (change.kind === "send") void queueSend(change.message);
    try {
      const { message } = await opRequest(change);
      if (change.kind === "send") {
        placeMessage(message);
        void unqueueSends([message.clientMessageId]);
      } else if (opsRef.current[key]?.seq === seq) applyUpdated(message);
      setOps(current => {
        if (current[key]?.seq !== seq) return current;
        // Nothing else can happen to a deleted message.
        return Object.fromEntries(Object.entries(current).filter(([k, other]) => k !== key && !(change.kind === "delete" && other.messageId === change.messageId)));
      });
    } catch (error) {
      const network = error instanceof TypeError;
      const failed = (change.kind === "send" && network
        ? { ...op, network }
        : { ...op, status: "failed", error: failureText(error, "Something went wrong."), network }) as MessageOp;
      setOps(current => current[key]?.seq === seq ? { ...current, [key]: failed } : current);
    }
  }, [opRequest, placeMessage, applyUpdated]);

  const retryOp = useCallback((op: MessageOp) => {
    if (op.kind === "send") placeMessage(op.message);
    void runOp(op);
  }, [runOp, placeMessage]);

  // Gives up on a failed change: an unsent message is discarded and an unsaved edit undone.
  const dismissOp = useCallback((op: MessageOp) => {
    setOps(current => {
      const { [op.key]: _dismissed, ...rest } = current;
      return rest;
    });
    if (op.kind === "send") {
      dropMessage(op.message.clientMessageId);
      void unqueueSends([op.message.clientMessageId]);
    }
  }, [dropMessage]);

  // Sends again every change that never reached the server: queued sends, in the order they were written,
  // and failed changes.
  const replayOffline = useCallback(() => {
    for (const op of Object.values(opsRef.current)) if (op.network) retryOp(op);
  }, [retryOp]);

  // Messages queued in an earlier visit that the server may not have yet. Their sends run before anything
  // new, and the ones the server already has come back as the stored message.
  useEffect(() => {
    if (!meId) return;
    let cancelled = false;
    void queuedSends(meId).then(messages => {
      if (cancelled) return;
      for (const message of messages) {
        const change = { kind: "send", messageId: message.id, message } as const;
        if (opsRef.current[opKey(change)]) continue;
        placeMessage(message);
        void runOp(change);
      }
    });
    return () => { cancelled = true; };
  }, [meId, placeMessage, runOp]);

  // The socket's reconnect also replays, but a short drop can leave the socket up.
  useEffect(() => {
    window.addEventListener("online", replayOffline);
    return () => window.removeEventListener("online", replayOffline);
  }, [replayOffline]);

  // ---- Socket --------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!meId) return;
    // The session cookie authenticates the handshake; no identity is sent from the browser.
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"], withCredentials: true });
    socketRef.current = socket;
    let hasConnected = false;
    socket.on("connect", () => {
      setSocketConnected(true);
      if (hasConnected) {
        // Events sent while we were offline are not replayed, so catch up from durable state.
        void refreshConversations();
        // Changes that never reached the server go out again now that it is back.
        replayOffline();
        api<{ reminders: ChatReminder[] }>("/api/reminders").then(data => setReminders(data.reminders)).catch(() => undefined);
        api<{ scheduledMessages: ChatScheduledMessage[] }>("/api/scheduled-messages").then(data => setScheduled(data.scheduledMessages)).catch(() => undefined);
        const conversationId = activeIdRef.current;
        if (conversationId) void loadMessages(conversationId, { catchUp: true });
        const parentId = threadIdRef.current;
        if (parentId) {
          api<{ parent: ChatMessage; messages: ChatMessage[]; nextCursor: string | null }>(`/api/messages/${parentId}/replies`)
            .then(data => setThread(current => current?.parentId === parentId ? { ...current, parent: data.parent, replies: keepUnsent(mergeMessages(current.replies.filter(r => !isOptimistic(r)), data.messages), current.replies) } : current))
            .catch(() => undefined);
        }
      }
      hasConnected = true;
    });
    socket.on("session:ready", () => {
      if (idleRef.current) socket.emit("presence:idle", { idle: true });
      socket.emit("presence:list", null, (list: Record<string, Presence>) => setPresence(list));
    });
    socket.on("connect_error", error => {
      if (error.message === "unauthorized") window.location.assign("/login");
    });
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("message:new", handleNew);
    socket.on("message:updated", applyUpdated);
    socket.on("conversation:created", addConversation);
    // Renamed, topic or description changed, archived or unarchived, or members joined or left.
    socket.on("conversation:updated", applyDetails);
    // The same user joined or left a public channel (here, in another tab, or was added or removed by someone).
    socket.on("conversation:membership", ({ conversationId, isMember }: { conversationId: string; isMember: boolean }) => {
      updateConversation(conversationId, c => ({ ...c, isMember }));
    });
    socket.on("conversation:removed", ({ conversationId }: { conversationId: string }) => removeConversation(conversationId));
    socket.on("conversation:read", ({ conversationId, lastReadAt }: { conversationId: string; lastReadAt: string }) => {
      updateConversation(conversationId, c => ({ ...c, unreadCount: 0, mentionCount: 0, lastReadAt: c.lastReadAt && c.lastReadAt > lastReadAt ? c.lastReadAt : lastReadAt }));
    });
    // The other member of a DM read up to lastReadAt. Cursors only move forward, so keep the later one.
    socket.on("conversation:seen", ({ conversationId, userId, lastReadAt }: { conversationId: string; userId: string; lastReadAt: string }) => {
      updateConversation(conversationId, c => {
        const current = c.readCursors[userId];
        return current && current >= lastReadAt ? c : { ...c, readCursors: { ...c.readCursors, [userId]: lastReadAt } };
      });
    });
    socket.on("presence:update", ({ userId, presence: next }: { userId: string; presence: Presence }) => {
      setPresence(current => current[userId] === next ? current : { ...current, [userId]: next });
    });
    socket.on("status:update", ({ userId, status }: { userId: string; status: UserStatus | null }) => setStatus(userId, status));
    // Pinning or unpinning a conversation in another tab or device.
    socket.on("pins:update", ({ conversationIds }: { conversationIds: string[] }) => setPinnedIds(conversationIds));
    // A draft saved in another tab or device (or the echo of our own save).
    socket.on("draft:update", ({ conversationId, draft }: { conversationId: string; draft: Draft | null }) => {
      if (!draftSavesRef.current.has(conversationId)) setDraft(conversationId, draft);
    });
    // A reminder was set, went off (firedAt set), was snoozed (firedAt null) or was marked done (null), here or in another tab.
    socket.on("reminder:update", ({ reminderId, reminder }: { reminderId: string; reminder: ChatReminder | null }) => {
      const justFired = Boolean(reminder?.firedAt) && !remindersRef.current.find(item => item.id === reminderId)?.firedAt;
      setReminders(current => upsertReminder(current, reminderId, reminder));
      if (justFired && reminder) alertReminder(reminder);
    });
    // A scheduled message was scheduled, changed, sent (null), failed or deleted (null), here or in another tab.
    socket.on("scheduled:update", ({ scheduledMessageId, scheduledMessage }: { scheduledMessageId: string; scheduledMessage: ChatScheduledMessage | null }) => {
      const before = scheduledRef.current.find(item => item.id === scheduledMessageId);
      if (scheduledMessage?.failedAt && before && !before.failedAt) setNotice(`A scheduled message wasn't sent: ${scheduledMessage.failReason ?? "something went wrong."} It's in Scheduled.`);
      setScheduled(current => upsertScheduled(current, scheduledMessageId, scheduledMessage));
    });
    // Our vote changed in another tab. Anonymous polls only tell each voter their own choices this way.
    socket.on("poll:votes", ({ messageId, optionIds }: { messageId: string; pollId: string; optionIds: string[] }) => setMyVotes(messageId, optionIds));
    socket.on("typing", (event: { conversationId: string; parentId: string | null; userId: string; displayName: string; typing: boolean }) => {
      if (event.userId === meId) return;
      const key = typingKey(event.conversationId, event.parentId);
      setTyping(current => {
        const entry = { ...(current[key] ?? {}) };
        if (event.typing) entry[event.userId] = { name: event.displayName, until: Date.now() + TYPING_TTL_MS };
        else delete entry[event.userId];
        return { ...current, [key]: entry };
      });
    });
    socket.on("chat:error", (payload: { message: string }) => setNotice(payload.message));
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [meId, loadMessages, refreshConversations, handleNew, applyUpdated, replayOffline, addConversation, applyDetails, removeConversation, updateConversation, setStatus, setDraft, alertReminder]);

  // Idle detection: no input in this tab for IDLE_AFTER_MS makes it idle. The server combines all of a
  // person's tabs, so they show as away only when every tab is idle.
  useEffect(() => {
    let lastInput = Date.now();
    const update = (value: boolean) => {
      if (idleRef.current === value) return;
      idleRef.current = value;
      setIdle(value);
      socketRef.current?.emit("presence:idle", { idle: value });
    };
    const onInput = () => { lastInput = Date.now(); update(false); };
    const onVisible = () => { if (document.visibilityState === "visible") onInput(); };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;
    events.forEach(name => window.addEventListener(name, onInput, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastInput >= IDLE_AFTER_MS) update(true);
    }, PRESENCE_TICK_MS);
    return () => {
      events.forEach(name => window.removeEventListener(name, onInput));
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  // Expire typing indicators whose sender went quiet without sending "stopped".
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping(current => {
        let changed = false;
        const next: TypingState = {};
        for (const [key, entry] of Object.entries(current)) {
          next[key] = Object.fromEntries(Object.entries(entry).filter(([, value]) => {
            const keep = value.until > now;
            if (!keep) changed = true;
            return keep;
          }));
        }
        return changed ? next : current;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  // "typing" in the composer; "replying" on a thread's parent in the message list.
  const typingText = useCallback((conversationId: string, parentId?: string | null, verb = "typing") => {
    const names = Object.values(typing[typingKey(conversationId, parentId)] ?? {}).map(value => value.name);
    if (!names.length) return null;
    if (names.length === 1) return `${names[0]} is ${verb}…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are ${verb}…`;
    return `Several people are ${verb}…`;
  }, [typing]);

  const emitTyping = useCallback((conversationId: string, parentId: string | null, isTyping: boolean) => {
    socketRef.current?.emit("typing", { conversationId, parentId, typing: isTyping });
  }, []);

  // ---- Actions -------------------------------------------------------------------------------------------

  const sendMessage = useCallback(async (conversationId: string, parentId: string | null, body: string, attachments: ChatAttachment[]) => {
    const state = bootstrapRef.current;
    if (!state) return false;
    const clientMessageId = crypto.randomUUID();
    const message: ChatMessage = {
      id: `optimistic-${clientMessageId}`, conversationId, authorId: state.me.id, clientMessageId, body, parentId,
      replyCount: 0, lastReplyAt: null, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
      author: { id: state.me.id, displayName: state.me.displayName, avatarColor: state.me.avatarColor }, reactions: [], attachments, linkPreviews: [], forwarded: null, poll: null
    };
    placeMessage(message);
    void runOp({ kind: "send", messageId: message.id, message });
    return true;
  }, [placeMessage, runOp]);

  const onReact = useCallback((message: ChatMessage, emoji: string, add: boolean) => {
    void runOp({ kind: "react", messageId: message.id, emoji, add });
  }, [runOp]);

  // Sets the viewer's poll choices on a loaded message (main list or thread), keeping its tallies.
  const setMyVotes = useCallback((messageId: string, optionIds: string[]) => {
    const update = (message: ChatMessage) => message.id === messageId && message.poll ? { ...message, poll: { ...message.poll, myVotes: optionIds } } : message;
    setHistory(current => ({ ...current, messages: current.messages.map(update) }));
    setThread(current => current && { ...current, parent: current.parent && update(current.parent), replies: current.replies.map(update) });
  }, []);

  // Votes show at once like other changes; closing and reopening wait for the server.
  const onAction = useCallback(async (message: ChatMessage, action: MessageAction) => {
    if (!message.poll) return;
    if (action.action === "poll.vote") return void runOp({ kind: "vote", messageId: message.id, optionIds: action.optionIds });
    try {
      const result = await api<{ message: ChatMessage }>(`/api/messages/${message.id}/actions`, { method: "POST", json: action });
      applyUpdated(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update the poll.");
    }
  }, [applyUpdated, runOp]);

  // "Remind me about this" on a message.
  const onRemind = useCallback(async (message: ChatMessage, at: Date) => {
    try {
      const { reminder } = await api<{ reminder: ChatReminder }>("/api/reminders", { method: "POST", json: { messageId: message.id, remindAt: at.toISOString() } });
      setReminders(current => upsertReminder(current, reminder.id, reminder));
      setNotice(`I'll remind you about this message ${reminderTimeLabel(at)}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not set the reminder.");
    }
  }, []);

  // The schedule button in a composer. Resolves true once scheduled, which clears the composer.
  const scheduleMessage = useCallback(async (conversationId: string, parentId: string | null, body: string, at: Date) => {
    try {
      const { scheduledMessage } = await api<{ scheduledMessage: ChatScheduledMessage }>("/api/scheduled-messages", { method: "POST", json: { conversationId, parentId: parentId ?? undefined, body, sendAt: at.toISOString() } });
      setScheduled(current => upsertScheduled(current, scheduledMessage.id, scheduledMessage));
      setNotice(`Message scheduled to send ${reminderTimeLabel(at)}. Find it under Scheduled.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not schedule the message.");
      return false;
    }
  }, []);

  // Send now, reschedule, edit (`text` shows names; encoded here) or delete a scheduled message. Shown at once
  // and put back on failure. A message sent meanwhile is gone from the list once its update arrives.
  async function changeScheduled(item: ChatScheduledMessage, change: { sendNow: true } | { sendAt: Date } | { text: string } | { delete: true }) {
    const state = bootstrapRef.current;
    if (!state) return;
    let json: Record<string, unknown> | null = null;
    let shown: ChatScheduledMessage | null = null;
    if ("delete" in change) shown = null;
    else if ("text" in change) {
      const mentioned = state.users.filter(user => item.body.includes(`<@${user.id}>`));
      const isChannel = state.conversations.find(c => c.id === item.conversationId)?.type === "CHANNEL";
      const body = encodeMentions(change.text, mentionTargets([...mentioned, ...state.users], isChannel));
      json = { body };
      shown = { ...item, body };
    } else {
      const sendAt = "sendAt" in change ? change.sendAt : new Date();
      json = "sendAt" in change ? { sendAt: sendAt.toISOString() } : { sendNow: true };
      shown = { ...item, sendAt: sendAt.toISOString(), failedAt: null, failReason: null };
    }
    setScheduled(current => upsertScheduled(current, item.id, shown));
    try {
      if (json) {
        const { scheduledMessage } = await api<{ scheduledMessage: ChatScheduledMessage }>(`/api/scheduled-messages/${item.id}`, { method: "PATCH", json });
        setScheduled(current => current.some(other => other.id === item.id) ? upsertScheduled(current, item.id, scheduledMessage) : current);
        if ("sendAt" in change) setNotice(`Message rescheduled to send ${reminderTimeLabel(change.sendAt)}.`);
      } else {
        await api(`/api/scheduled-messages/${item.id}`, { method: "DELETE" });
      }
    } catch (error) {
      setScheduled(current => upsertScheduled(current, item.id, item));
      setNotice(error instanceof Error ? error.message : "Could not update the scheduled message.");
    }
  }

  // Posts the poll from the /poll dialog. Throws so the dialog can show what went wrong.
  async function sendPoll(draft: PollDraft) {
    if (!pollDraft) return;
    const { conversationId, parentId } = pollDraft;
    const { question, ...poll } = draft;
    const { message } = await api<{ message: ChatMessage }>(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      json: { body: question, clientMessageId: crypto.randomUUID(), parentId: parentId ?? undefined, poll }
    });
    placeMessage(message);
    setPollDraft(null);
  }

  async function togglePin(conversationId: string) {
    const pin = !pinnedIds.includes(conversationId);
    const before = pinnedIds;
    setPinnedIds(current => pin ? [...current.filter(id => id !== conversationId), conversationId] : current.filter(id => id !== conversationId));
    try {
      const { pinnedConversationIds } = await api<{ pinnedConversationIds: string[] }>(`/api/conversations/${conversationId}/pin`, { method: pin ? "PUT" : "DELETE" });
      setPinnedIds(pinnedConversationIds);
    } catch (error) {
      setPinnedIds(before);
      setNotice(error instanceof Error ? error.message : pin ? "Could not pin conversation." : "Could not unpin conversation.");
    }
  }

  async function joinChannel(conversationId: string) {
    const myId = bootstrapRef.current?.me.id;
    if (!myId) return false;
    try {
      const { members } = await api<{ members: ChannelMember[] }>(`/api/conversations/${conversationId}/members`, { method: "POST", json: { userIds: [myId] } });
      updateConversation(conversationId, c => ({ ...c, isMember: true, memberCount: members.length }));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not join channel.");
      return false;
    }
  }

  // A public channel stays open as a preview after leaving; a private one is gone.
  async function leaveChannel(conversation: ConversationSummary) {
    const myId = bootstrapRef.current?.me.id;
    if (!myId) return false;
    const warning = conversation.isPrivate ? " It's private: you'll need to be added back by a member to rejoin." : "";
    if (!window.confirm(`Leave #${conversation.name}?${warning}`)) return false;
    try {
      await api(`/api/conversations/${conversation.id}/members/${myId}`, { method: "DELETE" });
      if (conversation.isPrivate) removeConversation(conversation.id);
      else updateConversation(conversation.id, c => ({ ...c, isMember: false, memberCount: Math.max(0, c.memberCount - 1) }));
      setNotice(`You left #${conversation.name}.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not leave channel.");
      return false;
    }
  }

  async function unarchiveChannel(conversation: ConversationSummary) {
    try {
      const { conversation: details } = await api<{ conversation: ConversationDetails }>(`/api/conversations/${conversation.id}`, { method: "PATCH", json: { archived: false } });
      applyDetails(details);
      setNotice(`#${details.name} was unarchived.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not unarchive channel.");
    }
  }

  function openDetails(tab: ChannelTab) {
    setDetailsTab(tab);
    setDialog("details");
  }

  const onEdit = useCallback((message: ChatMessage, body: string) => {
    void runOp({ kind: "edit", messageId: message.id, body });
  }, [runOp]);

  const onDelete = useCallback((message: ChatMessage) => {
    if (!window.confirm("Delete this message? This can't be undone.")) return;
    void runOp({ kind: "delete", messageId: message.id });
  }, [runOp]);

  const openThread = useCallback(async (parentId: string, parent: ChatMessage | null = null) => {
    setRightPanel("thread");
    setThread({ parentId, parent, replies: outgoing(opsRef.current, null, parentId), nextCursor: null, loading: true });
    try {
      const data = await api<{ parent: ChatMessage; messages: ChatMessage[]; nextCursor: string | null }>(`/api/messages/${parentId}/replies`);
      confirmSends(data.messages);
      setThread(current => current?.parentId === parentId ? { parentId, parent: data.parent, replies: keepUnsent(data.messages, current.replies), nextCursor: data.nextCursor, loading: false } : current);
    } catch (error) {
      setThread(current => current?.parentId === parentId ? { ...current, loading: false } : current);
      setNotice(error instanceof Error ? error.message : "Could not load thread.");
    }
  }, [confirmSends]);
  const onOpenThread = useCallback((message: ChatMessage) => void openThread(message.id, message), [openThread]);

  async function loadMoreReplies() {
    if (!thread?.nextCursor) return;
    const { parentId, nextCursor } = thread;
    setThread(current => current && { ...current, loading: true });
    try {
      const data = await api<{ messages: ChatMessage[]; nextCursor: string | null }>(`/api/messages/${parentId}/replies?cursor=${encodeURIComponent(nextCursor)}`);
      setThread(current => current?.parentId === parentId ? { ...current, replies: mergeMessages(current.replies, data.messages), nextCursor: data.nextCursor, loading: false } : current);
    } catch (error) {
      setThread(current => current && { ...current, loading: false });
      setNotice(error instanceof Error ? error.message : "Could not load replies.");
    }
  }

  const openConversation = useCallback((id: string) => {
    setActiveId(id);
    setShowSidebar(false);
    setDialog(null);
    // A thread belongs to its conversation, so close it when moving elsewhere.
    if (activeIdRef.current !== id) {
      setThread(null);
      setRightPanel(current => current === "thread" ? null : current);
    }
  }, []);

  const openDm = useCallback(async (userId: string) => {
    const state = bootstrapRef.current;
    if (!state) return;
    const name = [...new Set([state.me.id, userId])].sort().join(":");
    const existing = state.conversations.find(c => c.type === "DM" && c.name === name);
    if (existing) return openConversation(existing.id);
    try {
      const { conversation } = await api<{ conversation: ConversationSummary }>("/api/conversations/dm", { method: "POST", json: { userId } });
      addConversation(conversation);
      openConversation(conversation.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open direct message.");
    }
  }, [addConversation, openConversation]);

  // Sends one forward per target, creating DMs that do not exist yet. Returns true if every one was sent.
  async function forwardMessage(message: ChatMessage, targets: ForwardTarget[], comment: string) {
    const state = bootstrapRef.current;
    if (!state) return false;
    const body = encodeMentions(comment, mentionTargets(state.users, false));
    const results = await Promise.allSettled(targets.map(async target => {
      let conversationId: string;
      if (target.kind === "conversation") conversationId = target.id;
      else {
        const { conversation } = await api<{ conversation: ConversationSummary }>("/api/conversations/dm", { method: "POST", json: { userId: target.userId } });
        addConversation(conversation);
        conversationId = conversation.id;
      }
      const { message: sent } = await api<{ message: ChatMessage }>(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        json: { body, clientMessageId: crypto.randomUUID(), forwardedMessageId: message.id }
      });
      if (activeIdRef.current === conversationId) setHistory(current => ({ ...current, messages: upsertMessage(current.messages, sent) }));
      return conversationId;
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const sent = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (failed) {
      const reason = failed.reason instanceof Error ? failed.reason.message : "Message could not be forwarded.";
      setNotice(sent.length ? `Forwarded to ${sent.length} of ${targets.length}. ${reason}` : reason);
      return false;
    }
    const only = sent.length === 1 ? bootstrapRef.current?.conversations.find(c => c.id === sent[0]) : undefined;
    setNotice(only ? `Forwarded to ${only.type === "CHANNEL" ? "#" : ""}${label(only)}.` : `Forwarded to ${sent.length} conversations.`);
    return true;
  }

  const onForward = useCallback((message: ChatMessage) => setForwarding(message), []);
  // Only originals in conversations the viewer can see can be opened; anyone else just sees the card.
  // Reads the ref so it stays stable (the conversation list changes with every message) and MessageItem stays memoized.
  const openForwarded = useCallback((forward: ChatForward) => {
    if (!bootstrapRef.current?.conversations.some(c => c.id === forward.conversationId)) return null;
    return () => jumpToRef.current(forward.conversationId, forward.messageId, forward.parentId);
  }, []);

  function jumpTo(conversationId: string, messageId: string, parentId: string | null) {
    openConversation(conversationId);
    setRightPanel(null);
    if (parentId) void openThread(parentId);
    setHighlightId(messageId);
    jumpPagesRef.current = 0;
  }
  jumpToRef.current = jumpTo;
  const openHit = (hit: SearchHit) => jumpTo(hit.conversation.id, hit.message.id, hit.message.parentId);
  const openActivity = (item: ActivityItem) => jumpTo(item.conversationId, item.message.id, item.message.parentId);

  // Scroll a jumped-to message into view, paging back through history if it is older than what is loaded.
  useEffect(() => {
    if (!highlightId || !history.loaded) return;
    const index = messages.findIndex(message => message.id === highlightId);
    if (index !== -1) {
      virtualizer.scrollToIndex(index + 1, { align: "center" });
      const timer = setTimeout(() => setHighlightId(null), 4000);
      return () => clearTimeout(timer);
    }
    const inThread = thread?.replies.some(reply => reply.id === highlightId) || thread?.parentId === highlightId;
    if (!inThread && history.nextCursor && !loadingOlder && jumpPagesRef.current < MAX_JUMP_PAGES) {
      jumpPagesRef.current += 1;
      void loadOlder();
    }
  }, [highlightId, history, messages, thread, loadingOlder, loadOlder, virtualizer]);

  async function signOut() {
    socketRef.current?.disconnect();
    await authClient.signOut().catch(() => undefined);
    window.location.assign("/login");
  }

  async function saveStatus(patch: StatusPatch) {
    try {
      const { status } = await api<{ status: UserStatus | null }>("/api/status", { method: "PATCH", json: patch });
      if (me) setStatus(me.id, status);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update your status.");
      return false;
    }
  }

  function savePrefs(next: NotificationPrefs) {
    setPrefs(next);
    try { if (me) localStorage.setItem(`orbit-chat-notify:${me.id}`, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }

  // /poll, /remind and /status from a composer in `conversationId` (and thread `parentId`). Resolves true when
  // done, which clears the composer.
  async function runCommand(conversationId: string, parentId: string | null, name: Exclude<SlashCommandName, "giphy">, args: string) {
    if (name === "poll") {
      setPollDraft({ conversationId, parentId, ...parsePollArgs(args) });
      return true;
    }
    if (name === "status") {
      const parsed = parseStatus(args);
      if (parsed.kind === "open") {
        // The status menu lives in the sidebar, which is a drawer on small screens.
        if (window.matchMedia("(max-width: 767px)").matches) setShowSidebar(true);
        setMenu("status");
        return true;
      }
      if (parsed.kind === "error") { setNotice(parsed.error); return false; }
      const custom = parsed.kind === "clear" ? null : { emoji: parsed.emoji, text: parsed.text, expiresAt: null };
      const ok = await saveStatus({ custom });
      if (ok) setNotice(custom ? `Status set to ${[custom.emoji, custom.text].filter(Boolean).join(" ")}.` : "Status cleared.");
      return ok;
    }
    if (/^list$/i.test(args.trim())) { setRightPanel("reminders"); return true; }
    const parsed = parseReminder(args);
    if ("error" in parsed) { setNotice(parsed.error); return false; }
    try {
      const { reminder } = await api<{ reminder: ChatReminder }>("/api/reminders", { method: "POST", json: { text: parsed.text, remindAt: parsed.at.toISOString(), conversationId } });
      setReminders(current => upsertReminder(current, reminder.id, reminder));
      setNotice(`Reminder set ${reminderTimeLabel(parsed.at)}: “${parsed.text}”`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not set the reminder.");
      return false;
    }
  }

  // Done (or deleting one that has not gone off) removes the reminder; snoozing makes it wait again. Both show
  // at once and are put back on failure.
  async function settleReminder(reminder: ChatReminder, snooze: boolean) {
    const remindAt = new Date(Date.now() + SNOOZE_MS).toISOString();
    setReminders(current => upsertReminder(current, reminder.id, snooze ? { ...reminder, remindAt, firedAt: null } : null));
    try {
      await api(`/api/reminders/${reminder.id}`, snooze ? { method: "PATCH", json: { remindAt } } : { method: "DELETE" });
    } catch (error) {
      setReminders(current => upsertReminder(current, reminder.id, reminder));
      setNotice(error instanceof Error ? error.message : "Could not update the reminder.");
    }
  }

  const clearEditRequest = useCallback(() => setEditRequest(null), []);

  // Global shortcuts: ⌘K / Ctrl+K opens the palette, ⌘/ / Ctrl+/ opens help, Alt+↑/↓ move through the sidebar
  // and Esc marks the open conversation read.
  useEffect(() => {
    // Whether a dialog or menu was open when the key was pressed: its own Esc handler may close it first.
    let overlayWasOpen = false;
    const onKeyCapture = () => { overlayWasOpen = overlayOpenRef.current; };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "k") { event.preventDefault(); setDialog(current => current === "palette" ? null : "palette"); }
        if (event.key === "/") { event.preventDefault(); setDialog("help"); }
        return;
      }
      // Keys that an edit box, suggestion list or dialog already handled are theirs.
      if (event.defaultPrevented || overlayWasOpen) return;
      if (event.altKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const order = sidebarOrderRef.current;
        const index = order.indexOf(activeIdRef.current ?? "");
        const next = index === -1 ? (event.key === "ArrowDown" ? 0 : order.length - 1) : index + (event.key === "ArrowDown" ? 1 : -1);
        if (next !== index && next >= 0 && next < order.length) openConversation(order[next]);
        return;
      }
      if (event.key === "Escape" && !event.altKey && !event.shiftKey && activeIdRef.current) {
        // Hides the "New messages" line and lets the read effect mark the conversation read again if needed.
        setUnreadMarker(null);
        lastMarkedRef.current = "";
        setVisibleTick(tick => tick + 1);
      }
    };
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKeyCapture, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [openConversation]);

  // Keep the open conversation visible in the sidebar, e.g. after Alt+↓.
  useEffect(() => {
    if (activeId) document.querySelector(`[data-sidebar-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  useEffect(() => {
    if (!mentionToast) return;
    const timer = setTimeout(() => setMentionToast(null), MENTION_TOAST_MS);
    return () => clearTimeout(timer);
  }, [mentionToast]);

  // Unread mentions show in the tab title so they are noticed from other tabs too.
  const overdueReminders = reminders.filter(reminder => reminder.firedAt);
  const failedScheduled = scheduled.filter(item => item.failedAt);
  const totalMentions = bootstrap?.conversations.reduce((sum, c) => sum + (inSidebar(c) ? c.mentionCount : 0), 0) ?? 0;
  useEffect(() => {
    document.title = totalMentions > 0 ? `(@${totalMentions}) Orbit Chat` : "Orbit Chat";
  }, [totalMentions]);

  // ---- Render --------------------------------------------------------------------------------------------

  if (!bootstrap || !me) {
    return loadError
      ? <div className="flex min-h-dvh items-center justify-center p-6"><div className="w-full max-w-sm animate-fade-up text-center"><Logo className="mx-auto h-10 w-10 rounded-xl"/><h1 className="mt-5 text-lg font-semibold tracking-tight">Orbit Chat couldn&apos;t start</h1><p className="mt-1.5 text-sm text-zinc-500">{loadError}</p><Button className="mt-6" onClick={() => void loadBootstrap()}>Try again</Button></div></div>
      : <div className="flex min-h-dvh flex-col items-center justify-center gap-4 text-sm text-zinc-400"><Logo className="h-9 w-9 animate-pulse rounded-xl"/>Loading your workspace…</div>;
  }

  // Pinned channels and DMs move out of their usual section into Pinned, in the order they were pinned.
  const pinnedSet = new Set(pinnedIds);
  const matchesFilter = (c: ConversationSummary) => c.type === "CHANNEL"
    ? c.name.includes(filter.toLowerCase().replace(/^#/, ""))
    : (usersById.get(dmPartnerId(c, me.id))?.displayName ?? "").toLowerCase().includes(filter.toLowerCase());
  const pinnedConversations = pinnedIds.flatMap(id => bootstrap.conversations.find(c => c.id === id) ?? []).filter(c => inSidebar(c) && matchesFilter(c));
  const channels = bootstrap.conversations.filter(c => c.type === "CHANNEL" && inSidebar(c) && !pinnedSet.has(c.id) && matchesFilter(c));
  const dmByPartner = new Map(bootstrap.conversations.filter(c => c.type === "DM").map(c => [dmPartnerId(c, me.id), c]));
  const people = [...bootstrap.users]
    .filter(user => user.displayName.toLowerCase().includes(filter.toLowerCase()) && !pinnedSet.has(dmByPartner.get(user.id)?.id ?? ""))
    .sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || a.displayName.localeCompare(b.displayName));
  sidebarOrderRef.current = [...pinnedConversations, ...channels, ...people.flatMap(user => dmByPartner.get(user.id) ?? [])].map(c => c.id);
  const activePinned = activeConversation !== null && pinnedSet.has(activeConversation.id);
  const activeLabel = activeConversation ? label(activeConversation) : "Choose a conversation";
  const activePartner = activeConversation?.type === "DM" ? usersById.get(dmPartnerId(activeConversation, me.id)) : undefined;
  const activeChannel = activeConversation?.type === "CHANNEL" ? activeConversation : null;
  const activePermissions = activeChannel ? channelPermissions(activeChannel, me.id, canModerate) : null;
  const archivedNotice = activeChannel?.archivedAt ? `#${activeChannel.name} is archived, so it's read-only.` : null;
  // My messages waiting to be posted in the open conversation itself (not in its threads).
  const activeScheduled = scheduled.filter(item => item.conversationId === activeId && !item.parentId && !item.failedAt);
  const conversationTitle = (id: string) => { const c = bootstrap.conversations.find(item => item.id === id); return c ? c.type === "CHANNEL" ? `#${label(c)}` : label(c) : null; };
  // ↑ in an empty composer edits my last message there. Returns false when there is nothing to edit.
  const editLastMessage = () => {
    const index = lastEditable(messages, me.id);
    if (index === -1 || archivedNotice) return false;
    virtualizer.scrollToIndex(index + 1, { align: "auto" });
    setEditRequest({ id: messages[index].id, where: "main" });
    return true;
  };
  const editLastReply = () => {
    const threadMessages = shownThread?.parent ? [shownThread.parent, ...shownThread.replies] : [];
    const index = lastEditable(threadMessages, me.id);
    if (index === -1 || archivedNotice) return false;
    setEditRequest({ id: threadMessages[index].id, where: "thread" });
    return true;
  };
  // Public channels can mention anyone in the workspace; DMs and private channels only their members.
  const mentionable = bootstrap.users
    .filter(user => user.id !== me.id && (!activeConversation || (activeConversation.type === "CHANNEL" && !activeConversation.isPrivate) || activeConversation.memberIds.includes(user.id)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const presenceOf = (userId: string): Presence => userId === me.id
    ? socketConnected ? idle ? "away" : "active" : "offline"
    : presence[userId] ?? "offline";
  const statusOf = (userId: string) => bootstrap.statuses[userId];
  const myStatus = customStatus(statusOf(me.id), now);
  const myDnd = isDnd(statusOf(me.id), now);
  const statusEmoji = (userId: string) => {
    const status = customStatus(statusOf(userId), now);
    return status?.emoji && <span title={status.text ?? undefined} className="shrink-0 text-[13px] leading-none">{status.emoji}</span>;
  };
  // "Away · 📅 In a meeting · Notifications paused until 3:30 PM"
  const partnerLine = (userId: string) => {
    const status = statusOf(userId);
    const custom = customStatus(status, now);
    return [
      presenceLabels[presenceOf(userId)],
      custom && [custom.emoji, custom.text].filter(Boolean).join(" "),
      isDnd(status, now) && (status?.dndUntil ? `Notifications paused until ${untilLabel(status.dndUntil)}` : "Notifications paused")
    ].filter(Boolean).join(" · ");
  };
  const firstUnread = unreadMarker === null ? undefined : messages.find(m => m.createdAt > unreadMarker && m.authorId !== me.id && !isOptimistic(m));
  // "Seen" goes under my newest message that the DM partner has read, unless they have written since.
  const partnerReadAt = activePartner && activePartner.id !== me.id ? activeConversation?.readCursors[activePartner.id] : undefined;
  let seenId: string | undefined;
  if (partnerReadAt) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.authorId !== me.id) break;
      if (!isOptimistic(message) && message.createdAt <= partnerReadAt) { seenId = message.id; break; }
    }
  }
  const historyHeader = (
    <>
      {loadingOlder && <div className="flex justify-center py-3 text-zinc-300"><Loader2 size={16} className="animate-spin"/></div>}
      {!history.loaded && (
        <div aria-label="Loading messages" className="space-y-6 px-2 py-4">
          {[72, 48, 64].map(width => (
            <div key={width} className="flex animate-pulse gap-3">
              <div className="h-9 w-9 rounded-[10px] bg-zinc-100"/>
              <div className="flex-1 space-y-2 pt-1"><div className="h-3 w-28 rounded bg-zinc-100"/><div className="h-3 rounded bg-zinc-100" style={{ width: `${width}%` }}/></div>
            </div>
          ))}
        </div>
      )}
      {history.loaded && !history.nextCursor && activeConversation && (
        <div className="mb-8 px-2 pt-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500">
            {activePartner ? <Avatar name={activePartner.displayName} color={activePartner.avatarColor} size="lg"/> : activeConversation.isPrivate ? <Lock size={20}/> : <Hash size={22}/>}
          </div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight">{activePartner ? activeLabel : `#${activeLabel}`}</h2>
          <p className="mt-1 max-w-prose text-sm text-zinc-500">
            {activePartner
              ? activePartner.id === me.id ? "This is your space. Draft messages, keep notes or park links here." : `This is the beginning of your direct message history with ${activeLabel}.`
              : activeConversation.description || activeConversation.topic || `This is the very beginning of the #${activeLabel} channel.`}
          </p>
        </div>
      )}
      {history.loaded && messages.length === 0 && <p className="px-2 text-sm text-zinc-400">No messages yet. Say hello below.</p>}
    </>
  );
  const messageRow = (index: number) => {
    const message = messages[index];
    const previous = messages[index - 1];
    const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
    const showUnread = firstUnread?.id === message.id;
    return (
      <>
        {newDay && (
          <div className="my-3 flex items-center gap-3">
            <div className="h-px flex-1 bg-zinc-100"/>
            <span className="rounded-full border border-zinc-200/80 bg-card px-2.5 py-0.5 text-[11px] font-medium text-zinc-500">{dayLabel(message.createdAt)}</span>
            <div className="h-px flex-1 bg-zinc-100"/>
          </div>
        )}
        {showUnread && <div className="my-2 flex items-center gap-3"><div className="h-px flex-1 bg-brand-200"/><span className="text-[11px] font-medium text-brand-600">New messages</span></div>}
        <MessageItem message={message} grouped={!newDay && !showUnread && isGrouped(message, previous)} me={me} canModerate={canModerate} usersById={usersById}
          highlighted={highlightId === message.id} ops={opsForMessage.get(message.id)} onRetry={retryOp} onDismiss={dismissOp} onReact={onReact} onEdit={onEdit} onDelete={onDelete} onOpenThread={onOpenThread}
          replyTyping={typingText(message.conversationId, message.id, "replying")} readOnly={Boolean(archivedNotice)} onForward={onForward} onAction={onAction} onRemind={onRemind} openForwarded={openForwarded}
          editRequested={editRequest?.where === "main" && editRequest.id === message.id} onEditRequestHandled={clearEditRequest}/>
        {seenId === message.id && (
          <p title={`${activeLabel} has seen this`} className="flex items-center justify-end gap-1 px-2 pt-0.5 text-[11px] text-zinc-400"><CheckCheck size={13} className="text-brand-500"/>Seen</p>
        )}
      </>
    );
  };
  const countLabel = (count: number) => count >= 100 ? "99+" : count;
  const mentionBadge = (count: number) => (
    <span title={`${count} unread ${count === 1 ? "mention" : "mentions"} of you`} className="ml-auto flex items-center gap-0.5 rounded-md bg-amber-400 px-1.5 py-px text-[11px] font-semibold tabular-nums text-amber-950">
      <AtSign size={11} strokeWidth={2.5}/>{countLabel(count)}
    </span>
  );
  // Mentions outrank plain unread counts and are shown even in muted conversations.
  const unreadBadge = (conversation: ConversationSummary, muted: boolean) => conversation.mentionCount > 0
    ? mentionBadge(conversation.mentionCount)
    : conversation.unreadCount > 0 && (
      <span className={cn("ml-auto min-w-[20px] rounded-md px-1.5 py-px text-center text-[11px] font-semibold tabular-nums", muted ? "bg-zinc-200/70 text-zinc-500" : "bg-brand-600 text-white")}>{countLabel(conversation.unreadCount)}</span>
    );
  // Unsent text shows in place of the unread count (the row is still bold), so it is not forgotten. Mentions still win.
  const rowBadge = (conversation: ConversationSummary, muted: boolean) => drafts[conversation.id] && conversation.mentionCount === 0
    ? <span title="Unsent draft" className="ml-auto flex items-center gap-1 text-[11px] font-medium text-zinc-400"><Pencil size={11}/>Draft</span>
    : unreadBadge(conversation, muted);
  const navItem = (active: boolean, unread = false) => cn(
    "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition duration-150",
    active ? "bg-card font-medium text-zinc-900 shadow-float ring-1 ring-zinc-200/70" : unread ? "font-semibold text-zinc-900 hover:bg-zinc-200/50" : "text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900"
  );
  const sectionHeader = (title: string, action: React.ReactNode) => (
    <div className="mb-1 flex h-7 items-center justify-between pl-2.5 pr-1">
      <span className="text-xs font-medium text-zinc-400">{title}</span>
      {action}
    </div>
  );
  const iconAction = "rounded-md p-1 text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-700";
  const channelRow = (item: ConversationSummary) => {
    const active = activeId === item.id;
    const unread = item.unreadCount > 0 && !active;
    const mentioned = item.mentionCount > 0 && !active;
    const muted = prefs.muted.includes(item.id);
    const Icon = item.isPrivate ? Lock : Hash;
    return (
      <button key={item.id} data-sidebar-id={item.id} aria-current={active ? "page" : undefined} onClick={() => openConversation(item.id)} className={cn(navItem(active, mentioned || (unread && !muted)), muted && !mentioned && !active && "opacity-60")}>
        <Icon size={item.isPrivate ? 13 : 15} className={active ? "text-brand-600" : "text-zinc-400"}/><span className="truncate">{item.name}</span>
        {!active && rowBadge(item, muted)}
      </button>
    );
  };
  // One row per person; `dm` is the existing conversation with them, if any.
  const dmRow = (user: ChatUser, dm: ConversationSummary | undefined) => {
    const active = dm !== undefined && dm.id === activeId;
    const unread = dm !== undefined && (dm.unreadCount > 0 || dm.mentionCount > 0) && !active;
    return (
      <button key={user.id} data-sidebar-id={dm?.id} aria-current={active ? "page" : undefined} onClick={() => void openDm(user.id)} className={navItem(active, unread)}>
        <Avatar name={user.displayName} color={user.avatarColor} size="sm" presence={presenceOf(user.id)} dnd={isDnd(statusOf(user.id), now)}/>
        <span className="truncate">{user.displayName}{user.id === me.id && <span className="font-normal text-zinc-400"> (you)</span>}</span>
        {statusEmoji(user.id)}
        {dm && !active && rowBadge(dm, prefs.muted.includes(dm.id))}
      </button>
    );
  };

  return (
    <main className="relative flex h-dvh overflow-hidden bg-background">
      {showSidebar && <button aria-label="Close channel list" onClick={() => setShowSidebar(false)} className="absolute inset-0 z-20 bg-zinc-950/20 backdrop-blur-[1px] md:hidden"/>}
      <aside className={cn("absolute inset-y-0 left-0 z-30 flex w-[272px] shrink-0 flex-col border-r border-zinc-200/80 bg-surface transition-transform duration-200 md:static md:z-auto md:translate-x-0", showSidebar ? "translate-x-0 shadow-soft" : "-translate-x-full")}>
        <div className="relative px-3 pt-3">
          <button onClick={() => setMenu(current => current === "workspace" ? null : "workspace")} aria-expanded={menu === "workspace"} className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left transition hover:bg-zinc-200/50">
            <Logo/>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{bootstrap.workspace.name}</span>
            <ChevronDown size={15} className={cn("text-zinc-400 transition", menu === "workspace" && "rotate-180")}/>
          </button>
          {menu === "workspace" && (
            <WorkspaceMenu workspace={bootstrap.workspace} me={me} onCreateChannel={() => setDialog("create")} onHelp={() => setDialog("help")} onSignOut={() => void signOut()} onNotice={setNotice} onClose={() => setMenu(null)}/>
          )}
          <div className="mt-2 flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-card px-2.5 transition focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100">
            <Search size={14} className="shrink-0 text-zinc-400"/>
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter" aria-label="Filter channels and people" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-zinc-400"/>
            <button onClick={() => setDialog("palette")} title="Jump to or search (⌘K)" className="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-400 transition hover:border-zinc-300 hover:text-zinc-600">⌘K</button>
          </div>
          <nav aria-label="Workspace" className="mt-3 space-y-0.5">
            <button onClick={() => setRightPanel(current => current === "activity" ? null : "activity")} aria-pressed={rightPanel === "activity"} className={navItem(rightPanel === "activity", totalMentions > 0)}><AtSign size={15} className={totalMentions > 0 ? "text-amber-500" : "text-zinc-400"}/>Activity{totalMentions > 0 && mentionBadge(totalMentions)}</button>
            <button onClick={() => setRightPanel(current => current === "people" ? null : "people")} aria-pressed={rightPanel === "people"} className={navItem(rightPanel === "people")}><Users size={15} className="text-zinc-400"/>People</button>
            <button onClick={() => setRightPanel(current => current === "reminders" ? null : "reminders")} aria-pressed={rightPanel === "reminders"} className={navItem(rightPanel === "reminders", overdueReminders.length > 0)}>
              <AlarmClock size={15} className={overdueReminders.length > 0 ? "text-brand-600" : "text-zinc-400"}/>Reminders
              {overdueReminders.length > 0 && <span title={`${overdueReminders.length} overdue`} className="ml-auto min-w-[20px] rounded-md bg-brand-600 px-1.5 py-px text-center text-[11px] font-semibold tabular-nums text-white">{countLabel(overdueReminders.length)}</span>}
            </button>
            {(scheduled.length > 0 || rightPanel === "scheduled") && (
              <button onClick={() => setRightPanel(current => current === "scheduled" ? null : "scheduled")} aria-pressed={rightPanel === "scheduled"} className={navItem(rightPanel === "scheduled", failedScheduled.length > 0)}>
                <CalendarClock size={15} className={failedScheduled.length > 0 ? "text-rose-600" : "text-zinc-400"}/>Scheduled
                {failedScheduled.length > 0
                  ? <span title={`${failedScheduled.length} not sent`} className="ml-auto min-w-[20px] rounded-md bg-rose-600 px-1.5 py-px text-center text-[11px] font-semibold tabular-nums text-white">{countLabel(failedScheduled.length)}</span>
                  : <span className="ml-auto text-[11px] tabular-nums text-zinc-400">{countLabel(scheduled.length)}</span>}
              </button>
            )}
          </nav>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4 pt-5">
          {pinnedConversations.length > 0 && (
            <>
              {sectionHeader("Pinned", null)}
              <div className="space-y-0.5">
                {pinnedConversations.map(item => {
                  if (item.type === "CHANNEL") return channelRow(item);
                  const partner = usersById.get(dmPartnerId(item, me.id));
                  return partner ? dmRow(partner, item) : null;
                })}
              </div>
              <div className="mt-6"/>
            </>
          )}

          {sectionHeader("Channels", (
            <span className="flex items-center">
              <button title="Browse channels" aria-label="Browse channels" onClick={() => setDialog("browse")} className={iconAction}><Compass size={14}/></button>
              <button title="Create channel" aria-label="Create channel" onClick={() => setDialog("create")} className={iconAction}><Plus size={14}/></button>
            </span>
          ))}
          <div className="space-y-0.5">
            {channels.map(channelRow)}
            {channels.length === 0 && <p className="px-2.5 py-1 text-xs text-zinc-400">{filter ? "No channels match." : pinnedConversations.some(c => c.type === "CHANNEL") ? "All your channels are pinned." : "You haven't joined any channels."}</p>}
            {!filter && <button onClick={() => setDialog("browse")} className={cn(navItem(false), "text-zinc-500")}><Compass size={15} className="text-zinc-400"/>Browse channels</button>}
          </div>

          <div className="mt-6"/>
          {sectionHeader("Direct messages", <button title="New direct message" aria-label="New direct message" onClick={() => setDialog("palette")} className={iconAction}><Plus size={14}/></button>)}
          <div className="space-y-0.5">
            {people.map(user => dmRow(user, dmByPartner.get(user.id)))}
          </div>
        </div>

        <div className="relative border-t border-zinc-200/80 p-2">
          {menu === "status" && <StatusMenu me={me} status={statusOf(me.id)} presence={presenceOf(me.id)} onSave={saveStatus} onClose={() => setMenu(null)}/>}
          <div className="flex items-center gap-1 rounded-lg">
            <button onClick={() => setMenu(current => current === "status" ? null : "status")} aria-expanded={menu === "status"} title="Set a status" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 text-left transition hover:bg-zinc-200/50">
              <Avatar name={me.displayName} color={me.avatarColor} presence={socketConnected ? presenceOf(me.id) : undefined} dnd={myDnd}/>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{me.displayName}</div>
                <div className="flex items-center gap-1.5 truncate text-[11px] text-zinc-500">
                  {!socketConnected ? <><span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"/>Connecting…</>
                    : myStatus ? <><span>{myStatus.emoji}</span><span className="truncate">{myStatus.text ?? presenceLabels[presenceOf(me.id)]}</span></>
                    : myDnd ? "Notifications paused"
                    : <span className="text-zinc-400">{presenceLabels[presenceOf(me.id)]} · Set a status</span>}
                </div>
              </div>
            </button>
            <button title="Help & shortcuts" aria-label="Help and shortcuts" onClick={() => setDialog("help")} className={cn(iconAction, "p-1.5")}><HelpCircle size={15}/></button>
            <button title="Sign out" aria-label="Sign out" onClick={() => void signOut()} className={cn(iconAction, "p-1.5")}><LogOut size={15}/></button>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-card">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200/80 px-3 sm:px-5">
          <Button variant="ghost" size="icon" title="Channels" aria-label="Open channel list" onClick={() => setShowSidebar(true)} className="h-8 w-8 shrink-0 md:hidden"><Menu size={18}/></Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {activePartner ? <Avatar name={activePartner.displayName} color={activePartner.avatarColor} size="sm" presence={presenceOf(activePartner.id)} dnd={isDnd(statusOf(activePartner.id), now)}/>
              : activeConversation?.isPrivate ? <Lock size={15} className="shrink-0 text-zinc-400"/> : <Hash size={16} className="shrink-0 text-zinc-400"/>}
            {activeChannel
              ? <button onClick={() => openDetails("about")} title="Channel details" className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 transition hover:bg-zinc-100">
                  <h1 className="truncate text-[15px] font-semibold tracking-tight">{activeLabel}</h1><ChevronDown size={14} className="shrink-0 text-zinc-400"/>
                </button>
              : <h1 className="truncate text-[15px] font-semibold tracking-tight">{activeLabel}</h1>}
            {activeChannel?.archivedAt && <span className="flex shrink-0 items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600"><Archive size={11}/>Archived</span>}
            <span className="hidden min-w-0 truncate border-l border-zinc-200 pl-2.5 text-[13px] text-zinc-400 sm:block">
              {activePartner
                ? partnerLine(activePartner.id)
                : activeChannel && (activeChannel.topic
                  ? <button onClick={() => activePermissions?.canEditInfo ? openDetails("about") : undefined} title={activeChannel.topic} className="max-w-full truncate text-left">{activeChannel.topic}</button>
                  : activePermissions?.canEditInfo
                    ? <button onClick={() => openDetails("about")} className="transition hover:text-zinc-600">Add a topic</button>
                    : activeChannel.isPrivate ? "Private channel" : "Channel")}
            </span>
            {!socketConnected && <span className="ml-1 flex shrink-0 items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"/>Reconnecting</span>}
          </div>
          <div className="relative flex items-center gap-0.5">
            <Button variant="ghost" size="icon" title="Search (⌘K)" aria-label="Search" onClick={() => setDialog("palette")} className="h-8 w-8"><Search size={16}/></Button>
            <Button variant="ghost" size="icon" title="Notifications" aria-label="Notifications" aria-expanded={menu === "notifications"} onClick={() => setMenu(current => current === "notifications" ? null : "notifications")} className="h-8 w-8"><Bell size={16}/></Button>
            {activeConversation && (
              <Button variant="ghost" size="icon" title={activePinned ? "Unpin from sidebar" : "Pin to sidebar"} aria-label={activePinned ? "Unpin from sidebar" : "Pin to sidebar"} aria-pressed={activePinned}
                onClick={() => void togglePin(activeConversation.id)} className={cn("h-8 w-8", activePinned && "text-brand-600 hover:text-brand-700")}>
                <Pin size={16} className={cn(activePinned && "fill-current")}/>
              </Button>
            )}
            {activeChannel
              ? <Button variant="ghost" size="sm" title="Channel members" aria-label={`${activeChannel.memberCount} members`} onClick={() => openDetails("members")} className="h-8 gap-1.5 px-2 tabular-nums"><Users size={16}/>{activeChannel.memberCount}</Button>
              : <Button variant="ghost" size="icon" title="People" aria-label="People" onClick={() => setRightPanel(current => current === "people" ? null : "people")} className={cn("h-8 w-8", rightPanel === "people" && "bg-zinc-100 text-zinc-900")}><Users size={16}/></Button>}
            {menu === "notifications" && <NotificationsMenu prefs={prefs} onChange={savePrefs} conversation={activeConversation} label={activeLabel} onClose={() => setMenu(null)}/>}
          </div>
        </header>

        {notice && (
          <div role="status" className="mx-auto mt-3 flex w-[calc(100%-2rem)] max-w-3xl animate-fade-up items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-card px-3 py-2 text-[13px] text-zinc-700 shadow-float">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="Dismiss notice" className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={14}/></button>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-5">
          <div className="relative mx-auto max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
            {/* Rows stay in normal flow inside one translated wrapper, so hover toolbars can overlap neighbours. */}
            <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${virtualRows[0]?.start ?? 0}px)` }}>
              {virtualRows.map(row => (
                // flow-root keeps the rows' margins inside them, so measured heights match the layout.
                <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="flow-root">
                  {row.index === 0 ? historyHeader : messageRow(row.index - 1)}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-3 pb-2 sm:px-5 sm:pb-3">
          <div className="mx-auto max-w-3xl">
            {activeScheduled.length > 0 && (
              <button onClick={() => setRightPanel("scheduled")} className="mb-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800">
                <CalendarClock size={12} className="text-zinc-400"/>
                {activeScheduled.length === 1 ? `1 message scheduled to send ${reminderTimeLabel(new Date(activeScheduled[0].sendAt))}` : `${activeScheduled.length} messages scheduled here`}
                <span className="font-medium text-brand-600">View</span>
              </button>
            )}
            {activeChannel?.archivedAt ? (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-zinc-200/80 bg-zinc-50 px-4 py-3 text-[13px] text-zinc-600">
                <Archive size={15} className="text-zinc-400"/>You&apos;re viewing an archived channel. It&apos;s read-only.
                {activePermissions?.canArchive && <Button size="sm" variant="outline" onClick={() => void unarchiveChannel(activeChannel)}>Unarchive</Button>}
              </div>
            ) : activeChannel && !activeChannel.isMember ? (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-zinc-200/80 bg-zinc-50 px-4 py-3 text-[13px] text-zinc-600">
                <span>You&apos;re previewing <b className="font-semibold text-zinc-900">#{activeChannel.name}</b>.</span>
                <Button size="sm" variant="outline" onClick={() => openDetails("about")}>Details</Button>
                <Button size="sm" onClick={() => void joinChannel(activeChannel.id)}>Join channel</Button>
              </div>
            ) : activeConversation && (
              <Composer key={activeConversation.id} conversationId={activeConversation.id} placeholder={`Message ${activePartner ? activeLabel : `#${activeLabel}`}`}
                typingText={typingText(activeConversation.id)} autoFocus mentionable={mentionable} broadcastMentions={activeConversation.type === "CHANNEL"} onTyping={emitTyping} onNotice={setNotice}
                savedDraft={drafts[activeConversation.id]?.body} onDraftChange={body => saveDraft(activeConversation.id, body)}
                onSend={(body, attachments) => sendMessage(activeConversation.id, null, body, attachments)}
                onSchedule={(body, at) => scheduleMessage(activeConversation.id, null, body, at)}
                onEditLast={editLastMessage} onCommand={(name, args) => runCommand(activeConversation.id, null, name, args)}/>
            )}
          </div>
        </div>
      </section>

      {rightPanel && <button aria-label="Close panel" onClick={() => setRightPanel(null)} className="absolute inset-0 z-20 bg-zinc-950/20 backdrop-blur-[1px] xl:hidden"/>}
      {rightPanel === "thread" && shownThread && (
        <ThreadPanel thread={shownThread} ops={opsForMessage} onRetry={retryOp} onDismiss={dismissOp} conversationName={activePartner ? activeLabel : `#${activeLabel}`} me={me} canModerate={canModerate} usersById={usersById}
          typingText={typingText(shownThread.parent?.conversationId ?? activeId ?? "", shownThread.parentId)} highlightId={highlightId} mentionable={mentionable}
          broadcastMentions={activeConversation?.type === "CHANNEL"} readOnlyNotice={archivedNotice ?? (activeChannel && !activeChannel.isMember ? `Join #${activeChannel.name} to reply.` : null)} onClose={() => { setRightPanel(null); setThread(null); }} onLoadMore={() => void loadMoreReplies()}
          onSend={(body, attachments) => sendMessage(shownThread.parent?.conversationId ?? activeId ?? "", shownThread.parentId, body, attachments)}
          onSchedule={(body, at) => scheduleMessage(shownThread.parent?.conversationId ?? activeId ?? "", shownThread.parentId, body, at)}
          onTyping={emitTyping} onNotice={setNotice} onReact={onReact} onEdit={onEdit} onDelete={onDelete} onForward={onForward} onAction={onAction} onRemind={onRemind} openForwarded={openForwarded}
          editRequestId={editRequest?.where === "thread" ? editRequest.id : null} onEditRequestHandled={clearEditRequest} onEditLast={editLastReply}
          onCommand={(name, args) => runCommand(shownThread.parent?.conversationId ?? activeId ?? "", shownThread.parentId, name, args)}/>
      )}
      {rightPanel === "activity" && (
        <ActivityPanel usersById={usersById} conversationName={id => { const c = bootstrap.conversations.find(item => item.id === id); return c ? label(c) : "conversation"; }} onOpen={openActivity} onClose={() => setRightPanel(null)}/>
      )}
      {rightPanel === "reminders" && (
        <RemindersPanel reminders={reminders} now={now} usersById={usersById} onClose={() => setRightPanel(null)}
          sourceLabel={conversationTitle}
          onOpenSource={id => { setRightPanel(null); openConversation(id); }}
          onOpenMessage={reminder => reminder.message && reminder.conversationId && jumpTo(reminder.conversationId, reminder.message.id, reminder.message.parentId)}
          onDone={reminder => void settleReminder(reminder, false)} onSnooze={reminder => void settleReminder(reminder, true)}/>
      )}
      {rightPanel === "scheduled" && (
        <ScheduledPanel scheduled={scheduled} now={now} usersById={usersById} destinationLabel={conversationTitle} onClose={() => setRightPanel(null)}
          onOpen={item => { if (item.parentId) jumpTo(item.conversationId, item.parentId, item.parentId); else { setRightPanel(null); openConversation(item.conversationId); } }}
          onSendNow={item => void changeScheduled(item, { sendNow: true })} onReschedule={(item, at) => void changeScheduled(item, { sendAt: at })}
          onEdit={(item, text) => void changeScheduled(item, { text })} onDelete={item => void changeScheduled(item, { delete: true })}/>
      )}
      {rightPanel === "people" && <PeoplePanel users={bootstrap.users} meId={me.id} presenceOf={presenceOf} statusOf={statusOf} now={now} onOpenDm={userId => { setRightPanel(null); void openDm(userId); }} onClose={() => setRightPanel(null)}/>}

      <div className="pointer-events-none fixed right-4 top-16 z-40 flex max-h-[calc(100dvh-5rem)] w-[min(360px,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto">
        {mentionToast && (
          <div role="status" aria-live="polite" className="pointer-events-auto animate-pop-in">
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-card p-3 shadow-soft">
              <button onClick={() => { const { message } = mentionToast; setMentionToast(null); jumpTo(message.conversationId, message.id, message.parentId); }} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                <Avatar name={mentionToast.message.author.displayName} color={mentionToast.message.author.avatarColor}/>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] text-zinc-600">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-amber-400 text-amber-950"><AtSign size={10} strokeWidth={3}/></span>
                    <span className="truncate"><b className="font-semibold text-zinc-900">{mentionToast.message.author.displayName}</b> {mentionToast.kind === "direct" ? "mentioned you" : `notified @${mentionToast.kind}`} in {mentionToast.where}</span>
                  </span>
                  <span className="mt-1 line-clamp-2 block text-[13px] leading-5 text-zinc-800">{mentionsToText(markdownToText(mentionToast.message.body), id => usersById.get(id)?.displayName)}</span>
                  <span className="mt-1.5 block text-[11px] font-medium text-amber-700">View message</span>
                </span>
              </button>
              <button onClick={() => setMentionToast(null)} aria-label="Dismiss" className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={14}/></button>
            </div>
          </div>
        )}
        {/* Overdue reminders pop up here, unless the Reminders panel already shows them. */}
        {rightPanel !== "reminders" && overdueReminders.map(reminder => {
          const source = reminder.conversationId ? bootstrap.conversations.find(c => c.id === reminder.conversationId) : undefined;
          return (
            <div key={reminder.id} role="status" aria-live="polite" className="pointer-events-auto flex animate-pop-in items-start gap-3 rounded-xl border border-zinc-200 bg-card p-3 shadow-soft">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><AlarmClock size={16}/></span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-zinc-500">
                  Reminder · {dayLabel(reminder.remindAt) === "Today" ? timeLabel(reminder.remindAt) : `${dayLabel(reminder.remindAt)} at ${timeLabel(reminder.remindAt)}`}
                  {source && <> · <button onClick={() => openConversation(source.id)} className="font-medium text-brand-600 transition hover:underline">{source.type === "CHANNEL" ? `#${label(source)}` : label(source)}</button></>}
                </p>
                <div className="mt-0.5"><ReminderSubject reminder={reminder} usersById={usersById}/></div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Button size="sm" onClick={() => void settleReminder(reminder, false)} className="h-7 px-2.5 text-xs">Mark as done</Button>
                  <Button size="sm" variant="outline" onClick={() => void settleReminder(reminder, true)} className="h-7 px-2.5 text-xs">Snooze 20 min</Button>
                  {reminder.message && !reminder.message.deleted && reminder.conversationId && (
                    <Button size="sm" variant="ghost" onClick={() => jumpTo(reminder.conversationId!, reminder.message!.id, reminder.message!.parentId)} className="h-7 px-2 text-xs text-brand-600">View message</Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {dialog === "palette" && (
        <CommandPalette conversations={bootstrap.conversations} users={bootstrap.users} me={me} label={label} onOpenConversation={openConversation}
          onOpenDm={userId => { setDialog(null); void openDm(userId); }} onOpenHit={hit => { setDialog(null); openHit(hit); }} onClose={() => setDialog(null)}/>
      )}
      {dialog === "create" && (
        <CreateChannelDialog users={bootstrap.users} me={me} onClose={() => setDialog(null)} onCreated={conversation => { addConversation(conversation); setDialog(null); openConversation(conversation.id); }}/>
      )}
      {dialog === "help" && <HelpDialog onClose={() => setDialog(null)}/>}
      {dialog === "browse" && (
        <BrowseChannelsDialog conversations={bootstrap.conversations} onOpen={openConversation} onJoin={joinChannel} onCreate={() => setDialog("create")} onClose={() => setDialog(null)}/>
      )}
      {dialog === "details" && activeChannel && (
        <ChannelDetailsDialog key={activeChannel.id} conversation={activeChannel} me={me} users={bootstrap.users} usersById={usersById} isWorkspaceAdmin={canModerate}
          presenceOf={presenceOf} initialTab={detailsTab} onDetails={applyDetails} onJoin={() => joinChannel(activeChannel.id)} onLeave={() => leaveChannel(activeChannel)}
          onOpenDm={userId => { setDialog(null); void openDm(userId); }} onNotice={setNotice} onClose={() => setDialog(null)}/>
      )}
      {pollDraft && <CreatePollDialog initial={pollDraft} onCreate={sendPoll} onClose={() => setPollDraft(null)}/>}
      {forwarding && (
        <ForwardDialog message={forwarding} conversations={bootstrap.conversations} users={bootstrap.users} me={me} usersById={usersById} label={label}
          onForward={(targets, comment) => forwardMessage(forwarding, targets, comment)} onClose={() => setForwarding(null)}/>
      )}
    </main>
  );
}
