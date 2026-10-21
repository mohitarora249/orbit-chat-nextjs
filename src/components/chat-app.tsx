"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  AtSign, Bell, CheckCheck, ChevronDown, Hash, HelpCircle, Loader2, Lock, LogOut, Menu, Pencil, Pin, Plus, Search, Users, X
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { ActivityPanel, PeoplePanel, ThreadPanel, type ThreadState } from "@/components/chat/panels";
import { CommandPalette, CreateChannelDialog, ForwardDialog, HelpDialog, NotificationsMenu, WorkspaceMenu, type ForwardTarget, type NotificationPrefs } from "@/components/chat/dialogs";
import { StatusMenu, type StatusPatch } from "@/components/chat/status-menu";
import { compareMessages, conversationLabel, dayLabel, dmPartnerId, isGrouped, isOptimistic, mergeMessages, upsertMessage } from "@/components/chat/helpers";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { encodeMentions, mentionsMe, mentionsToText, mentionTargets } from "@/lib/mentions";
import { customStatus, IDLE_AFTER_MS, isDnd, presenceLabels, untilLabel, type Presence, type UserStatus } from "@/lib/presence";
import { playSound, primeSounds } from "@/lib/sounds";
import { cn } from "@/lib/utils";
import type { ActivityItem, Bootstrap, ChatAttachment, ChatForward, ChatMessage, ChatUser, ConversationSummary, Draft, MessagePage, SearchHit } from "@/lib/types";

type History = { messages: ChatMessage[]; nextCursor: string | null; loaded: boolean };
type TypingState = Record<string, Record<string, { name: string; until: number }>>;
type RightPanel = "thread" | "activity" | "people" | null;
type MentionToast = { message: ChatMessage; kind: NonNullable<ReturnType<typeof mentionsMe>>; where: string };

const PAGE_SIZE = 50;
const TYPING_TTL_MS = 6000;
const MENTION_TOAST_MS = 8000;
// How often to re-check idleness and re-render for statuses that expire.
const PRESENCE_TICK_MS = 30 * 1000;
// When jumping to an old search result, give up after this many pages of history.
const MAX_JUMP_PAGES = 10;
const emptyHistory: History = { messages: [], nextCursor: null, loaded: false };

const typingKey = (conversationId: string, parentId?: string | null) => `${conversationId}|${parentId ?? ""}`;

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
  const [dialog, setDialog] = useState<"palette" | "create" | "help" | null>(null);
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

  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  // Distance from the bottom of the scroller before older messages are prepended, so the view does not jump.
  const prependAnchorRef = useRef<number | null>(null);
  const atBottomRef = useRef(true);
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
  bootstrapRef.current = bootstrap;
  prefsRef.current = prefs;
  idleRef.current = idle;
  threadIdRef.current = thread?.parentId ?? null;

  const me = bootstrap?.me ?? null;
  const usersById = useMemo(() => new Map((bootstrap?.users ?? []).map(user => [user.id, user])), [bootstrap?.users]);
  const label = useCallback((conversation: ConversationSummary) => conversationLabel(conversation, me?.id ?? "", usersById), [me?.id, usersById]);
  const activeConversation = useMemo(() => bootstrap?.conversations.find(c => c.id === activeId) ?? null, [bootstrap, activeId]);
  const canModerate = bootstrap?.workspace.role === "OWNER" || bootstrap?.workspace.role === "ADMIN";

  const updateConversation = useCallback((id: string, update: (conversation: ConversationSummary) => ConversationSummary) => {
    setBootstrap(current => current && { ...current, conversations: current.conversations.map(c => c.id === id ? update(c) : c) });
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
  }, [fetchPage]);

  const loadOlder = useCallback(async () => {
    const conversationId = activeIdRef.current;
    if (!conversationId || !history.nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(conversationId, { cursor: history.nextCursor });
      if (activeIdRef.current !== conversationId) return;
      const scroller = scrollRef.current;
      prependAnchorRef.current = scroller ? scroller.scrollHeight - scroller.scrollTop : null;
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
    setHistory(emptyHistory);
    atBottomRef.current = true;
    jumpPagesRef.current = 0;
    setUnreadMarker(bootstrapRef.current?.conversations.find(c => c.id === activeId)?.lastReadAt ?? null);
    void loadMessages(activeId, { signal: controller.signal });
    try { if (bootstrapRef.current) localStorage.setItem(`orbit-chat-last:${bootstrapRef.current.me.id}`, activeId); } catch { /* storage unavailable */ }
    return () => controller.abort();
  }, [activeId, loadMessages]);

  // Infinite scroll: load the previous page when the top of the list comes into view.
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadOlderRef.current();
    }, { root, rootMargin: "400px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-observing after each page fires again if the top is still visible (e.g. short pages, tall screens).
  }, [bootstrap !== null, history.loaded, history.nextCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (prependAnchorRef.current === null || !scroller) return;
    scroller.scrollTop = scroller.scrollHeight - prependAnchorRef.current;
    prependAnchorRef.current = null;
  }, [history.messages]);

  // Follow the bottom when a newer message arrives, but only if the reader is already there (or sent it).
  const lastMessage = history.messages[history.messages.length - 1];
  useEffect(() => {
    if (!lastMessage) return;
    if (atBottomRef.current || lastMessage.authorId === me?.id) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessage?.id, history.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const apply = (list: ChatMessage[]) => remove ? list.filter(item => item.id !== message.id) : list.map(item => item.id === message.id ? message : item);
    if (!message.parentId) setHistory(current => ({ ...current, messages: apply(current.messages) }));
    setThread(current => {
      if (!current) return current;
      if (current.parentId === message.id) return { ...current, parent: message };
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
    if (!mentionsMe(message.body, state.me.id) && conversation?.type !== "DM") return;
    const where = conversation?.type === "DM" ? "" : ` in #${conversation?.name ?? "a channel"}`;
    const body = mentionsToText(message.body, id => state.users.find(user => user.id === id)?.displayName);
    const notification = new Notification(`${message.author.displayName}${where}`, { body: body || (message.forwarded ? "Forwarded a message" : "Sent an attachment"), tag: message.id });
    notification.onclick = () => {
      window.focus();
      setActiveId(message.conversationId);
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
    const fromOther = Boolean(state) && message.authorId !== state?.me.id;
    // Any mention alerts live. @here only reaches people who are online and not away.
    const kind = fromOther ? mentionsMe(message.body, state!.me.id) : null;
    const mention = kind === "here" && idleRef.current ? null : kind;
    const dnd = isDnd(state?.statuses[state.me.id]);
    // "Seeing it" means the message landed in what is on screen right now: the open thread for a reply,
    // the open conversation for a top-level message.
    const seeing = document.visibilityState === "visible" && (message.parentId
      ? threadIdRef.current === message.parentId
      : message.conversationId === activeIdRef.current);
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
      const conversation = state?.conversations.find(c => c.id === message.conversationId);
      const where = conversation?.type === "DM" ? "a direct message" : `#${conversation?.name ?? "a channel"}`;
      setMentionToast({ message, kind: mention, where: message.parentId ? `a thread in ${where}` : where });
    }
    if (fromOther && !seeing && !dnd && !message.id.startsWith("optimistic-") && prefsRef.current.sound && !prefsRef.current.muted.includes(message.conversationId)) {
      const isDm = state?.conversations.find(c => c.id === message.conversationId)?.type === "DM";
      playSound(mention || isDm ? "mention" : "message");
    }
    notify(message);
  }, [notify, updateConversation]);

  useEffect(() => primeSounds(), []);

  // ---- Socket --------------------------------------------------------------------------------------------

  const meId = me?.id;
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
        const conversationId = activeIdRef.current;
        if (conversationId) void loadMessages(conversationId, { catchUp: true });
        const parentId = threadIdRef.current;
        if (parentId) {
          api<{ parent: ChatMessage; messages: ChatMessage[]; nextCursor: string | null }>(`/api/messages/${parentId}/replies`)
            .then(data => setThread(current => current?.parentId === parentId ? { ...current, parent: data.parent, replies: mergeMessages(current.replies.filter(r => !isOptimistic(r)), data.messages) } : current))
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
  }, [meId, loadMessages, refreshConversations, handleNew, applyUpdated, addConversation, updateConversation, setStatus, setDraft]);

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
    const optimistic: ChatMessage = {
      id: `optimistic-${clientMessageId}`, conversationId, authorId: state.me.id, clientMessageId, body, parentId,
      replyCount: 0, lastReplyAt: null, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
      author: { id: state.me.id, displayName: state.me.displayName, avatarColor: state.me.avatarColor }, reactions: [], attachments, linkPreviews: [], forwarded: null
    };
    const place = (message: ChatMessage) => {
      if (parentId) setThread(current => current?.parentId === parentId ? { ...current, replies: upsertMessage(current.replies, message) } : current);
      else if (activeIdRef.current === conversationId) setHistory(current => ({ ...current, messages: upsertMessage(current.messages, message) }));
    };
    atBottomRef.current = true;
    place(optimistic);
    try {
      const { message } = await api<{ message: ChatMessage }>(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        json: { body, clientMessageId, parentId: parentId ?? undefined, attachmentIds: attachments.map(attachment => attachment.id) }
      });
      place(message);
      return true;
    } catch (error) {
      const drop = (list: ChatMessage[]) => list.filter(item => item.clientMessageId !== clientMessageId);
      if (parentId) setThread(current => current && { ...current, replies: drop(current.replies) });
      else setHistory(current => ({ ...current, messages: drop(current.messages) }));
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
      return false;
    }
  }, []);

  const onReact = useCallback(async (message: ChatMessage, emoji: string, add: boolean) => {
    const myId = bootstrapRef.current?.me.id;
    if (!myId) return;
    // Optimistic toggle; the server response (and the realtime event) carries the canonical counts.
    const reactions = add
      ? message.reactions.some(r => r.emoji === emoji)
        ? message.reactions.map(r => r.emoji === emoji ? { ...r, userIds: [...new Set([...r.userIds, myId])] } : r)
        : [...message.reactions, { emoji, userIds: [myId] }]
      : message.reactions.map(r => r.emoji === emoji ? { ...r, userIds: r.userIds.filter(id => id !== myId) } : r).filter(r => r.userIds.length);
    applyUpdated({ ...message, reactions });
    try {
      const result = await api<{ message: ChatMessage }>(`/api/messages/${message.id}/reactions`, { method: add ? "PUT" : "DELETE", json: { emoji } });
      applyUpdated(result.message);
    } catch (error) {
      applyUpdated(message);
      setNotice(error instanceof Error ? error.message : "Could not update reaction.");
    }
  }, [applyUpdated]);

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

  const onEdit = useCallback(async (message: ChatMessage, body: string) => {
    try {
      const result = await api<{ message: ChatMessage }>(`/api/messages/${message.id}`, { method: "PATCH", json: { body } });
      applyUpdated(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not edit message.");
      throw error;
    }
  }, [applyUpdated]);

  const onDelete = useCallback(async (message: ChatMessage) => {
    if (!window.confirm("Delete this message? This can't be undone.")) return;
    try {
      const result = await api<{ message: ChatMessage }>(`/api/messages/${message.id}`, { method: "DELETE" });
      applyUpdated(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete message.");
    }
  }, [applyUpdated]);

  const openThread = useCallback(async (parentId: string, parent: ChatMessage | null = null) => {
    setRightPanel("thread");
    setThread({ parentId, parent, replies: [], nextCursor: null, loading: true });
    try {
      const data = await api<{ parent: ChatMessage; messages: ChatMessage[]; nextCursor: string | null }>(`/api/messages/${parentId}/replies`);
      setThread(current => current?.parentId === parentId ? { parentId, parent: data.parent, replies: data.messages, nextCursor: data.nextCursor, loading: false } : current);
    } catch (error) {
      setThread(current => current?.parentId === parentId ? { ...current, loading: false } : current);
      setNotice(error instanceof Error ? error.message : "Could not load thread.");
    }
  }, []);
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
    const element = document.getElementById(`message-${highlightId}`);
    if (element) {
      element.scrollIntoView({ block: "center" });
      atBottomRef.current = false;
      const timer = setTimeout(() => setHighlightId(null), 4000);
      return () => clearTimeout(timer);
    }
    const inThread = thread?.replies.some(reply => reply.id === highlightId) || thread?.parentId === highlightId;
    if (!inThread && history.nextCursor && !loadingOlder && jumpPagesRef.current < MAX_JUMP_PAGES) {
      jumpPagesRef.current += 1;
      void loadOlder();
    }
  }, [highlightId, history, thread, loadingOlder, loadOlder]);

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

  // Global shortcuts: ⌘K / Ctrl+K opens the palette, ⌘/ / Ctrl+/ opens help.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setDialog(current => current === "palette" ? null : "palette"); }
      if (event.key === "/") { event.preventDefault(); setDialog("help"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!mentionToast) return;
    const timer = setTimeout(() => setMentionToast(null), MENTION_TOAST_MS);
    return () => clearTimeout(timer);
  }, [mentionToast]);

  // Unread mentions show in the tab title so they are noticed from other tabs too.
  const totalMentions = bootstrap?.conversations.reduce((sum, c) => sum + c.mentionCount, 0) ?? 0;
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
  const pinnedConversations = pinnedIds.flatMap(id => bootstrap.conversations.find(c => c.id === id) ?? []).filter(matchesFilter);
  const channels = bootstrap.conversations.filter(c => c.type === "CHANNEL" && !pinnedSet.has(c.id) && matchesFilter(c));
  const dmByPartner = new Map(bootstrap.conversations.filter(c => c.type === "DM").map(c => [dmPartnerId(c, me.id), c]));
  const people = [...bootstrap.users]
    .filter(user => user.displayName.toLowerCase().includes(filter.toLowerCase()) && !pinnedSet.has(dmByPartner.get(user.id)?.id ?? ""))
    .sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || a.displayName.localeCompare(b.displayName));
  const activePinned = activeConversation !== null && pinnedSet.has(activeConversation.id);
  const activeLabel = activeConversation ? label(activeConversation) : "Choose a conversation";
  const activePartner = activeConversation?.type === "DM" ? usersById.get(dmPartnerId(activeConversation, me.id)) : undefined;
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
  const firstUnread = unreadMarker === null ? undefined : history.messages.find(m => m.createdAt > unreadMarker && m.authorId !== me.id && !isOptimistic(m));
  // "Seen" goes under my newest message that the DM partner has read, unless they have written since.
  const partnerReadAt = activePartner && activePartner.id !== me.id ? activeConversation?.readCursors[activePartner.id] : undefined;
  let seenId: string | undefined;
  if (partnerReadAt) {
    for (let i = history.messages.length - 1; i >= 0; i--) {
      const message = history.messages[i];
      if (message.authorId !== me.id) break;
      if (!isOptimistic(message) && message.createdAt <= partnerReadAt) { seenId = message.id; break; }
    }
  }
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
    active ? "bg-white font-medium text-zinc-900 shadow-float ring-1 ring-zinc-200/70" : unread ? "font-semibold text-zinc-900 hover:bg-zinc-200/50" : "text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900"
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
      <button key={item.id} onClick={() => openConversation(item.id)} className={cn(navItem(active, mentioned || (unread && !muted)), muted && !mentioned && !active && "opacity-60")}>
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
      <button key={user.id} onClick={() => void openDm(user.id)} className={navItem(active, unread)}>
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
          <div className="mt-2 flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white px-2.5 transition focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100">
            <Search size={14} className="shrink-0 text-zinc-400"/>
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter" aria-label="Filter channels and people" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-zinc-400"/>
            <button onClick={() => setDialog("palette")} title="Jump to or search (⌘K)" className="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-400 transition hover:border-zinc-300 hover:text-zinc-600">⌘K</button>
          </div>
          <nav aria-label="Workspace" className="mt-3 space-y-0.5">
            <button onClick={() => setRightPanel(current => current === "activity" ? null : "activity")} aria-pressed={rightPanel === "activity"} className={navItem(rightPanel === "activity", totalMentions > 0)}><AtSign size={15} className={totalMentions > 0 ? "text-amber-500" : "text-zinc-400"}/>Activity{totalMentions > 0 && mentionBadge(totalMentions)}</button>
            <button onClick={() => setRightPanel(current => current === "people" ? null : "people")} aria-pressed={rightPanel === "people"} className={navItem(rightPanel === "people")}><Users size={15} className="text-zinc-400"/>People</button>
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

          {sectionHeader("Channels", <button title="Create channel" aria-label="Create channel" onClick={() => setDialog("create")} className={iconAction}><Plus size={14}/></button>)}
          <div className="space-y-0.5">
            {channels.map(channelRow)}
            {channels.length === 0 && <p className="px-2.5 py-1 text-xs text-zinc-400">{filter ? "No channels match." : pinnedConversations.some(c => c.type === "CHANNEL") ? "All your channels are pinned." : "No channels yet."}</p>}
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

      <section className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200/80 px-3 sm:px-5">
          <Button variant="ghost" size="icon" title="Channels" aria-label="Open channel list" onClick={() => setShowSidebar(true)} className="h-8 w-8 shrink-0 md:hidden"><Menu size={18}/></Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {activePartner ? <Avatar name={activePartner.displayName} color={activePartner.avatarColor} size="sm" presence={presenceOf(activePartner.id)} dnd={isDnd(statusOf(activePartner.id), now)}/>
              : activeConversation?.isPrivate ? <Lock size={15} className="shrink-0 text-zinc-400"/> : <Hash size={16} className="shrink-0 text-zinc-400"/>}
            <h1 className="truncate text-[15px] font-semibold tracking-tight">{activeLabel}</h1>
            <span className="hidden min-w-0 truncate border-l border-zinc-200 pl-2.5 text-[13px] text-zinc-400 sm:block">
              {activePartner
                ? partnerLine(activePartner.id)
                : activeConversation?.topic || (activeConversation?.isPrivate ? "Private channel" : "Channel")}
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
            <Button variant="ghost" size="icon" title="People" aria-label="People" onClick={() => setRightPanel(current => current === "people" ? null : "people")} className={cn("h-8 w-8", rightPanel === "people" && "bg-zinc-100 text-zinc-900")}><Users size={16}/></Button>
            {menu === "notifications" && <NotificationsMenu prefs={prefs} onChange={savePrefs} conversation={activeConversation} label={activeLabel} onClose={() => setMenu(null)}/>}
          </div>
        </header>

        {notice && (
          <div role="status" className="mx-auto mt-3 flex w-[calc(100%-2rem)] max-w-3xl animate-fade-up items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-700 shadow-float">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="Dismiss notice" className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={14}/></button>
          </div>
        )}

        <div ref={scrollRef} onScroll={event => { const el = event.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }} className="flex-1 overflow-y-auto px-3 py-6 sm:px-5">
          <div className="mx-auto max-w-3xl">
            <div ref={topSentinelRef}/>
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
                    : activeConversation.topic || `This is the very beginning of the #${activeLabel} channel.`}
                </p>
              </div>
            )}
            {history.messages.map((message, index) => {
              const previous = history.messages[index - 1];
              const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
              const showUnread = firstUnread?.id === message.id;
              return (
                <Fragment key={message.id}>
                  {newDay && (
                    <div className="my-3 flex items-center gap-3">
                      <div className="h-px flex-1 bg-zinc-100"/>
                      <span className="rounded-full border border-zinc-200/80 bg-white px-2.5 py-0.5 text-[11px] font-medium text-zinc-500">{dayLabel(message.createdAt)}</span>
                      <div className="h-px flex-1 bg-zinc-100"/>
                    </div>
                  )}
                  {showUnread && <div className="my-2 flex items-center gap-3"><div className="h-px flex-1 bg-brand-200"/><span className="text-[11px] font-medium text-brand-600">New messages</span></div>}
                  <MessageItem message={message} grouped={!newDay && !showUnread && isGrouped(message, previous)} me={me} canModerate={canModerate} usersById={usersById}
                    highlighted={highlightId === message.id} onReact={onReact} onEdit={onEdit} onDelete={onDelete} onOpenThread={onOpenThread}
                    replyTyping={typingText(message.conversationId, message.id, "replying")} onForward={onForward} openForwarded={openForwarded}/>
                  {seenId === message.id && (
                    <p title={`${activeLabel} has seen this`} className="flex items-center justify-end gap-1 px-2 pt-0.5 text-[11px] text-zinc-400"><CheckCheck size={13} className="text-brand-500"/>Seen</p>
                  )}
                </Fragment>
              );
            })}
            {history.loaded && history.messages.length === 0 && <p className="px-2 text-sm text-zinc-400">No messages yet. Say hello below.</p>}
            <div ref={bottomRef}/>
          </div>
        </div>

        <div className="px-3 pb-2 sm:px-5 sm:pb-3">
          <div className="mx-auto max-w-3xl">
            {activeConversation && (
              <Composer key={activeConversation.id} conversationId={activeConversation.id} placeholder={`Message ${activePartner ? activeLabel : `#${activeLabel}`}`}
                typingText={typingText(activeConversation.id)} autoFocus mentionable={mentionable} broadcastMentions={activeConversation.type === "CHANNEL"} onTyping={emitTyping} onNotice={setNotice}
                savedDraft={drafts[activeConversation.id]?.body} onDraftChange={body => saveDraft(activeConversation.id, body)}
                onSend={(body, attachments) => sendMessage(activeConversation.id, null, body, attachments)}/>
            )}
          </div>
        </div>
      </section>

      {rightPanel && <button aria-label="Close panel" onClick={() => setRightPanel(null)} className="absolute inset-0 z-20 bg-zinc-950/20 backdrop-blur-[1px] xl:hidden"/>}
      {rightPanel === "thread" && thread && (
        <ThreadPanel thread={thread} conversationName={activePartner ? activeLabel : `#${activeLabel}`} me={me} canModerate={canModerate} usersById={usersById}
          typingText={typingText(thread.parent?.conversationId ?? activeId ?? "", thread.parentId)} highlightId={highlightId} mentionable={mentionable}
          broadcastMentions={activeConversation?.type === "CHANNEL"} onClose={() => { setRightPanel(null); setThread(null); }} onLoadMore={() => void loadMoreReplies()}
          onSend={(body, attachments) => sendMessage(thread.parent?.conversationId ?? activeId ?? "", thread.parentId, body, attachments)}
          onTyping={emitTyping} onNotice={setNotice} onReact={onReact} onEdit={onEdit} onDelete={onDelete} onForward={onForward} openForwarded={openForwarded}/>
      )}
      {rightPanel === "activity" && (
        <ActivityPanel usersById={usersById} conversationName={id => { const c = bootstrap.conversations.find(item => item.id === id); return c ? label(c) : "conversation"; }} onOpen={openActivity} onClose={() => setRightPanel(null)}/>
      )}
      {rightPanel === "people" && <PeoplePanel users={bootstrap.users} meId={me.id} presenceOf={presenceOf} statusOf={statusOf} now={now} onOpenDm={userId => { setRightPanel(null); void openDm(userId); }} onClose={() => setRightPanel(null)}/>}

      {mentionToast && (
        <div role="status" aria-live="polite" className="fixed right-4 top-16 z-40 w-[min(360px,calc(100vw-2rem))] animate-pop-in">
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-white p-3 shadow-soft">
            <button onClick={() => { const { message } = mentionToast; setMentionToast(null); jumpTo(message.conversationId, message.id, message.parentId); }} className="flex min-w-0 flex-1 items-start gap-3 text-left">
              <Avatar name={mentionToast.message.author.displayName} color={mentionToast.message.author.avatarColor}/>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] text-zinc-600">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-amber-400 text-amber-950"><AtSign size={10} strokeWidth={3}/></span>
                  <span className="truncate"><b className="font-semibold text-zinc-900">{mentionToast.message.author.displayName}</b> {mentionToast.kind === "direct" ? "mentioned you" : `notified @${mentionToast.kind}`} in {mentionToast.where}</span>
                </span>
                <span className="mt-1 line-clamp-2 block text-[13px] leading-5 text-zinc-800">{mentionsToText(mentionToast.message.body, id => usersById.get(id)?.displayName)}</span>
                <span className="mt-1.5 block text-[11px] font-medium text-amber-700">View message</span>
              </span>
            </button>
            <button onClick={() => setMentionToast(null)} aria-label="Dismiss" className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={14}/></button>
          </div>
        </div>
      )}

      {dialog === "palette" && (
        <CommandPalette conversations={bootstrap.conversations} users={bootstrap.users} me={me} label={label} onOpenConversation={openConversation}
          onOpenDm={userId => { setDialog(null); void openDm(userId); }} onOpenHit={hit => { setDialog(null); openHit(hit); }} onClose={() => setDialog(null)}/>
      )}
      {dialog === "create" && (
        <CreateChannelDialog users={bootstrap.users} me={me} onClose={() => setDialog(null)} onCreated={conversation => { addConversation(conversation); setDialog(null); openConversation(conversation.id); }}/>
      )}
      {dialog === "help" && <HelpDialog onClose={() => setDialog(null)}/>}
      {forwarding && (
        <ForwardDialog message={forwarding} conversations={bootstrap.conversations} users={bootstrap.users} me={me} usersById={usersById} label={label}
          onForward={(targets, comment) => forwardMessage(forwarding, targets, comment)} onClose={() => setForwarding(null)}/>
      )}
    </main>
  );
}
