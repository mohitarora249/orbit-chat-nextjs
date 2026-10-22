"use client";

import { ClipboardEvent, DragEvent, Fragment, FormEvent, KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AlarmClock, ArrowUp, AtSign, BarChart3, CalendarClock, ImagePlay, Loader2, Megaphone, Paperclip, Shuffle, Smile, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/components/chat/emoji-picker";
import { nextMondayAt9, tomorrowAt9, WhenMenu, type WhenOption } from "@/components/chat/when-menu";
import { api } from "@/lib/api";
import { parseCommand, SLASH_COMMANDS, type SlashCommandName } from "@/lib/commands";
import { encodeMentions, mentionsToText, mentionTargets, parseMentions, type BroadcastMention } from "@/lib/mentions";
import { cn, formatBytes } from "@/lib/utils";
import type { ChatAttachment, ChatUser, Gif } from "@/lib/types";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_MENTION_SUGGESTIONS = 6;
// Keys the suggestion list handles itself; caret moves from any other key re-check for an "@" query.
const MENTION_KEYS = new Set(["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"]);
// Drafts are saved this long after the last keystroke, and right away when the composer goes away.
const DRAFT_SAVE_DELAY_MS = 800;

type MentionQuery = { start: number; query: string };

// An "@" at the start of the text or after whitespace, followed by up to two words, ending at the caret.
// Two words so that "@Aisha K" still narrows to "Aisha Khan".
function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@]*(?: [^\s@]*)?)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null;
}

function matchesMention(name: string, query: string) {
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  return lower.startsWith(q) || lower.split(/\s+/).some(word => word.startsWith(q));
}

const BROADCASTS: { kind: BroadcastMention; hint: string }[] = [
  { kind: "channel", hint: "Notify everyone in this channel" },
  { kind: "here", hint: "Notify everyone online right now" }
];

type CommandSuggestion = { kind: "command"; name: SlashCommandName; usage: string; hint: string; immediate?: boolean };
type Suggestion = { kind: "user"; user: ChatUser } | { kind: BroadcastMention; hint: string } | CommandSuggestion;

const COMMAND_ICONS: Record<SlashCommandName, React.ReactNode> = { giphy: <ImagePlay size={13}/>, poll: <BarChart3 size={13}/>, remind: <AlarmClock size={13}/>, status: <Smile size={13}/> };

const suggestionGroup = (suggestion: Suggestion) => suggestion.kind === "user" ? "People" : suggestion.kind === "command" ? "Commands" : "Notify";

// The command being typed: "/" and letters, nothing after them yet.
const COMMAND_QUERY = /^\/([a-z]*)$/i;

const SCHEDULE_OPTIONS: WhenOption[] = [
  { label: "Tomorrow morning", at: tomorrowAt9 },
  { label: "Next Monday morning", at: nextMondayAt9 }
];

// A /giphy search waiting to be sent, shuffled or cancelled. Only this person sees it.
type GifPreview = { query: string; gifs: Gif[]; index: number };

type Upload = { localId: string; fileName: string; size: number; state: "uploading" | "ready" | "error"; attachment?: ChatAttachment; error?: string };

export type ComposerProps = {
  conversationId: string;
  parentId?: string;
  placeholder: string;
  typingText: string | null;
  compact?: boolean;
  // People who can be @mentioned here, in suggestion order.
  mentionable: ChatUser[];
  // Offer @channel and @here (channels only, not DMs).
  broadcastMentions?: boolean;
  autoFocus?: boolean;
  // Unsent text saved for this conversation (mentions as <@id> tokens), and where to save changes to it.
  // Attachments are not part of a draft.
  savedDraft?: string;
  onDraftChange?: (body: string) => void;
  onSend: (body: string, attachments: ChatAttachment[]) => Promise<boolean>;
  // Schedules the text to be sent at `at` (text only: files are sent straight away). Resolves true once
  // scheduled, which clears the text. Without it there is no schedule button.
  onSchedule?: (body: string, at: Date) => Promise<boolean>;
  // ↑ in an empty composer: start editing the user's last message here. Returns false if there is none.
  onEditLast?: () => boolean;
  // Runs /poll, /remind and /status; /giphy is handled here. Resolves true once done, which clears the text.
  // Without it, text starting with "/" is sent as a message.
  onCommand?: (name: Exclude<SlashCommandName, "giphy">, args: string) => Promise<boolean>;
  // Called with this composer's own conversation and thread, so a "stopped" sent on unmount reaches the
  // place the user was typing in, not wherever the app has moved on to.
  onTyping: (conversationId: string, parentId: string | null, typing: boolean) => void;
  onNotice: (message: string) => void;
};

// Uploads go straight to private storage: reserve + presigned PUT URL, upload, then "complete" to start
// the malware scan. The message can be sent while scanning; the file only becomes downloadable once clean.
async function uploadFile(conversationId: string, file: File) {
  const { attachment, uploadUrl, uploadHeaders } = await api<{ attachment: ChatAttachment; uploadUrl: string; uploadHeaders: Record<string, string> }>(
    `/api/conversations/${conversationId}/attachments`,
    { method: "POST", json: { fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size } }
  );
  const put = await fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: file });
  if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
  const done = await api<{ attachment: ChatAttachment }>(`/api/attachments/${attachment.id}/complete`, { method: "POST" });
  return done.attachment;
}

// A saved draft as the composer shows it: names instead of <@id> tokens, with those people already picked.
// Tokens for people who cannot be mentioned here stay as they are, so saving again keeps them.
function decodeDraft(body: string, mentionable: ChatUser[]) {
  const byId = new Map(mentionable.map(user => [user.id, user]));
  const picked = parseMentions(body).flatMap(part => typeof part !== "string" && part.kind === "user" ? byId.get(part.userId) ?? [] : []);
  return { text: mentionsToText(body, id => byId.get(id)?.displayName, null), picked: [...new Set(picked)] };
}

export function Composer({ conversationId, parentId, placeholder, typingText, compact, autoFocus, mentionable, broadcastMentions, savedDraft = "", onDraftChange, onSend, onSchedule, onEditLast, onCommand, onTyping, onNotice }: ComposerProps) {
  const [initial] = useState(() => decodeDraft(savedDraft, mentionable));
  const [draft, setDraft] = useState(initial.text);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState(false);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // People chosen from the suggestions. The draft shows their names; on send, those names become <@id>
  // tokens, and a chosen person wins over someone else with the same name.
  const [picked, setPicked] = useState<ChatUser[]>(initial.picked);
  const [dragging, setDragging] = useState(false);
  // The text when Esc closed the command list, so it stays closed until the text changes.
  const [dismissedCommand, setDismissedCommand] = useState<string | null>(null);
  const [gif, setGif] = useState<GifPreview | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const typingRef = useRef(false);

  // The caret goes after any restored draft, ready to carry on typing.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!autoFocus || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [autoFocus, conversationId, parentId]);

  // Where to put the caret after a programmatic edit (mention, emoji). Applied in the same commit as the new
  // value, before the next keystroke can land: a deferred update would misplace text typed in between.
  const pendingCaretRef = useRef<number | null>(null);

  // Grow with the draft up to the max-height, then scroll.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    const caret = pendingCaretRef.current;
    if (caret !== null) {
      pendingCaretRef.current = null;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    }
  }, [draft]);

  // Draft sync. `savedRef` is the body last saved or received; the local text differs from it only while
  // a save is pending. Saves wait for a pause in typing; a pending save is flushed when the composer goes away.
  const encode = (text: string, people: ChatUser[]) => encodeMentions(text, mentionTargets([...people, ...mentionable], Boolean(broadcastMentions)));
  const encoded = encode(draft, picked);
  const savedRef = useRef(savedDraft);
  const encodedRef = useRef(encoded);
  encodedRef.current = encoded;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const saveDraft = useCallback((body: string) => {
    if (body === savedRef.current) return;
    savedRef.current = body;
    onDraftChangeRef.current?.(body);
  }, []);

  useEffect(() => {
    if (encoded === savedRef.current) return;
    const timer = setTimeout(() => saveDraft(encoded), DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [encoded, saveDraft]);

  useEffect(() => () => saveDraft(encodedRef.current), [saveDraft]);

  // The draft changed in another tab or device. Take it unless there are local edits not yet saved: those
  // are newer, and saving them shortly overrides it.
  useEffect(() => {
    if (savedDraft === savedRef.current) return;
    const dirty = encodedRef.current !== savedRef.current;
    savedRef.current = savedDraft;
    if (dirty) return;
    const next = decodeDraft(savedDraft, mentionable);
    setDraft(next.text);
    setPicked(next.picked);
  }, [savedDraft]); // eslint-disable-line react-hooks/exhaustive-deps -- a changed member list is not a new draft

  // "Typing" is re-announced every few seconds while the user keeps typing (peers expire it after ~6s);
  // "stopped" is sent once.
  const lastTypingRef = useRef(0);
  function setTyping(typing: boolean) {
    if (typing) {
      typingRef.current = true;
      if (Date.now() - lastTypingRef.current < 2500) return;
      lastTypingRef.current = Date.now();
    } else {
      if (!typingRef.current) return;
      typingRef.current = false;
      lastTypingRef.current = 0;
    }
    onTyping(conversationId, parentId ?? null, typing);
  }

  useEffect(() => () => { if (typingRef.current) onTyping(conversationId, parentId ?? null, false); }, [onTyping, conversationId, parentId]);

  function addFiles(files: FileList | File[]) {
    const list = [...files];
    if (uploads.length + list.length > MAX_FILES) { onNotice(`You can attach up to ${MAX_FILES} files per message.`); return; }
    for (const file of list) {
      if (file.size > MAX_FILE_BYTES) { onNotice(`${file.name} is larger than ${formatBytes(MAX_FILE_BYTES)}.`); continue; }
      if (file.size === 0) { onNotice(`${file.name} is empty.`); continue; }
      const localId = crypto.randomUUID();
      setUploads(current => [...current, { localId, fileName: file.name, size: file.size, state: "uploading" }]);
      uploadFile(conversationId, file)
        .then(attachment => setUploads(current => current.map(item => item.localId === localId ? { ...item, state: "ready", attachment } : item)))
        .catch(error => setUploads(current => current.map(item => item.localId === localId ? { ...item, state: "error", error: error instanceof Error ? error.message : "Upload failed." } : item)));
    }
  }

  const uploading = uploads.some(item => item.state === "uploading");
  const ready = uploads.filter(item => item.state === "ready" && item.attachment).map(item => item.attachment!);
  const canSend = !sending && !uploading && (draft.trim().length > 0 || ready.length > 0);

  function clearDraft() {
    setDraft("");
    setPicked([]);
    setTyping(false);
    saveDraft("");
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    // While suggestions are open, Enter picks a person; it must never send.
    if (!canSend || suggesting) return;
    const text = draft.trim();
    // "/remind ..." runs a command; "//text" sends "/text".
    const command = onCommand && !text.startsWith("//") ? parseCommand(text) : null;
    if (command) { void runCommand(command.name, command.args); return; }
    const body = encode(onCommand && text.startsWith("//") ? text.slice(1) : text, picked);
    const sentUploads = uploads;
    const sentPicked = picked;
    setSending(true);
    setDraft("");
    setUploads([]);
    setPicked([]);
    setTyping(false);
    // Cleared now rather than after the usual delay, so a reload right after sending does not bring it back.
    // A message that fails to send stays in the list with a retry; the text only comes back here if it was
    // never shown there (see below), and that is saved again.
    saveDraft("");
    const ok = await onSend(body, ready);
    if (!ok) {
      setDraft(text);
      setUploads(sentUploads);
      setPicked(sentPicked);
    }
    setSending(false);
    textareaRef.current?.focus();
  }

  // Like submit, but the text goes out later. Cleared now and put back if scheduling fails.
  async function schedule(at: Date) {
    setScheduling(false);
    const text = draft.trim();
    if (!onSchedule || !text || sending) return;
    if (onCommand && !text.startsWith("//") && parseCommand(text)) { onNotice("Commands can't be scheduled. To schedule this as a message, start it with \"//\"."); return; }
    const body = encode(onCommand && text.startsWith("//") ? text.slice(1) : text, picked);
    const sentPicked = picked;
    setSending(true);
    clearDraft();
    const ok = await onSchedule(body, at);
    if (!ok) {
      setDraft(text);
      setPicked(sentPicked);
    }
    setSending(false);
    textareaRef.current?.focus();
  }

  async function runCommand(name: string, args: string) {
    const known = SLASH_COMMANDS.find(command => command.name === name);
    if (!known || !onCommand) { onNotice(`/${name} isn't a command. To send it as a message, start it with "//".`); return; }
    setSending(true);
    let done = false;
    try {
      done = known.name === "giphy" ? await searchGifs(args) : await onCommand(known.name, args);
      if (done) clearDraft();
    } finally {
      setSending(false);
      // A GIF preview takes focus (its Send button), so Enter sends it and Esc cancels; the poll dialog
      // focuses its own first field.
      if (!(done && (known.name === "giphy" || known.name === "poll"))) textareaRef.current?.focus();
    }
  }

  async function searchGifs(query: string) {
    if (!query) { onNotice("Add what to search for, like /giphy high five."); return false; }
    try {
      const { gifs } = await api<{ gifs: Gif[] }>(`/api/giphy?q=${encodeURIComponent(query)}`);
      if (!gifs.length) { onNotice(`No GIFs found for "${query}".`); return false; }
      setGif({ query, gifs, index: 0 });
      return true;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not search GIFs.");
      return false;
    }
  }

  function shuffleGif() {
    setGif(current => {
      if (!current || current.gifs.length < 2) return current;
      // Any other result, never the same one twice in a row.
      const pick = Math.floor(Math.random() * (current.gifs.length - 1));
      return { ...current, index: pick >= current.index ? pick + 1 : pick };
    });
  }

  function closeGif() {
    setGif(null);
    textareaRef.current?.focus();
  }

  async function sendGif() {
    if (!gif || sending) return;
    const preview = gif;
    setGif(null);
    setSending(true);
    const ok = await onSend(preview.gifs[preview.index].url, []);
    if (!ok) setGif(preview);
    setSending(false);
    textareaRef.current?.focus();
  }

  const commandQuery = onCommand && draft !== dismissedCommand ? COMMAND_QUERY.exec(draft)?.[1].toLowerCase() : undefined;
  const suggestions: Suggestion[] = commandQuery !== undefined
    ? SLASH_COMMANDS.filter(command => command.name.startsWith(commandQuery)).map(command => ({ kind: "command" as const, ...command }))
    : mention ? [
      ...mentionable.filter(user => matchesMention(user.displayName, mention.query)).slice(0, MAX_MENTION_SUGGESTIONS).map(user => ({ kind: "user" as const, user })),
      ...(broadcastMentions ? BROADCASTS.filter(item => matchesMention(item.kind, mention.query)) : [])
    ] : [];
  const suggesting = suggestions.length > 0;
  const activeMention = Math.min(mentionIndex, suggestions.length - 1);

  function updateMention(text: string, caret: number | null) {
    const next = caret === null ? null : findMentionQuery(text, caret);
    setMention(current => current?.start === next?.start && current?.query === next?.query ? current : next);
    if (next?.start !== mention?.start || next?.query !== mention?.query) setMentionIndex(0);
  }

  function pickSuggestion(suggestion: Suggestion) {
    if (suggestion.kind !== "command") { pickMention(suggestion); return; }
    if (suggestion.immediate) { void runCommand(suggestion.name, ""); return; }
    const next = `/${suggestion.name} `;
    setDraft(next);
    pendingCaretRef.current = next.length;
  }

  function pickMention(suggestion: Exclude<Suggestion, CommandSuggestion>) {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    const label = suggestion.kind === "user" ? suggestion.user.displayName : suggestion.kind;
    if (suggestion.kind === "user") setPicked(current => [suggestion.user, ...current.filter(user => user.id !== suggestion.user.id)]);
    const inserted = `@${label}${/^\s/.test(draft.slice(end)) ? "" : " "}`;
    setDraft(draft.slice(0, mention.start) + inserted + draft.slice(end));
    setMention(null);
    const caret = mention.start + inserted.length;
    pendingCaretRef.current = caret;
  }

  // The toolbar button: start a mention at the caret, adding a space first if it would be glued to a word.
  function startMention() {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const prefix = start > 0 && !/\s/.test(draft[start - 1]) ? " @" : "@";
    const next = draft.slice(0, start) + prefix + draft.slice(end);
    const caret = start + prefix.length;
    setDraft(next);
    updateMention(next, caret);
    pendingCaretRef.current = caret;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Alt+↑/↓ switch conversations (handled by the app).
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) return;
    if (suggesting) {
      if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex(index => (index + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex(index => (index - 1 + suggestions.length) % suggestions.length); return; }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pickSuggestion(suggestions[activeMention]);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMention(null); setDismissedCommand(draft); return; }
    }
    if (gif && !draft) {
      if (event.key === "Escape") { event.preventDefault(); setGif(null); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendGif(); return; }
    }
    if (event.key === "ArrowUp" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !draft && !uploads.length && onEditLast?.()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void submit();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (event.clipboardData.files.length) {
      event.preventDefault();
      addFiles(event.clipboardData.files);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  }

  function insertEmoji(emoji: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    setPicker(false);
    pendingCaretRef.current = start + emoji.length;
  }

  return (
    <div>
      <form onSubmit={submit} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={cn("relative rounded-xl border bg-card shadow-float transition duration-150 focus-within:border-zinc-300 focus-within:shadow-soft", dragging ? "border-brand-400 ring-4 ring-brand-100" : "border-zinc-200")}>
        {suggesting && (
          <ul id={`${listId}-mentions`} role="listbox" aria-label={commandQuery !== undefined ? "Commands" : "Mention suggestions"} className="absolute bottom-full left-0 z-40 mb-2 w-72 max-w-full animate-pop-in overflow-hidden rounded-xl border border-zinc-200/80 bg-card p-1 shadow-soft">
            {suggestions.map((suggestion, index) => (
              <Fragment key={suggestion.kind === "user" ? suggestion.user.id : suggestion.kind === "command" ? suggestion.name : suggestion.kind}>
                {(index === 0 || suggestionGroup(suggestion) !== suggestionGroup(suggestions[index - 1])) && (
                  <li role="presentation" className={cn("px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-zinc-400", index > 0 && "mt-1 border-t border-zinc-100")}>{suggestionGroup(suggestion)}</li>
                )}
                <li id={`${listId}-mention-${index}`} role="option" aria-selected={index === activeMention}
                  // mousedown, not click: keep focus in the textarea so the caret position is not lost.
                  onMouseDown={event => { event.preventDefault(); pickSuggestion(suggestion); }} onMouseEnter={() => setMentionIndex(index)}
                  className={cn("flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]", index === activeMention ? "bg-zinc-100 text-zinc-900" : "text-zinc-700")}>
                  {suggestion.kind === "user" ? (
                    <>
                      <Avatar name={suggestion.user.displayName} color={suggestion.user.avatarColor} size="sm"/>
                      <span className="truncate font-medium">{suggestion.user.displayName}</span>
                    </>
                  ) : suggestion.kind === "command" ? (
                    <>
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600">{COMMAND_ICONS[suggestion.name]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{suggestion.usage}</span>
                        <span className="block truncate text-[11px] leading-4 text-zinc-400">{suggestion.hint}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700"><Megaphone size={13}/></span>
                      <span className="font-medium">@{suggestion.kind}</span>
                      <span className="truncate text-[11px] text-zinc-400">{suggestion.hint}</span>
                    </>
                  )}
                </li>
              </Fragment>
            ))}
            <li role="presentation" className="mt-1 border-t border-zinc-100 px-2.5 pb-1 pt-1.5 text-[11px] text-zinc-400">↑↓ choose · Enter insert · Esc dismiss</li>
          </ul>
        )}
        {gif && (
          <div aria-label={`GIF preview for ${gif.query}`} role="group" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeGif(); } }}
            className="mx-2 mt-2 animate-pop-in rounded-lg border border-zinc-200 bg-zinc-50 p-2">
            <div className="flex items-center justify-between gap-2 px-0.5 text-[11px] text-zinc-500">
              <span className="truncate">Only visible to you · <b className="font-medium text-zinc-700">/giphy {gif.query}</b></span>
              <span className="shrink-0 tabular-nums text-zinc-400">{gif.index + 1} of {gif.gifs.length}</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- GIFs are served by GIPHY */}
            <img src={gif.gifs[gif.index].url} alt={gif.gifs[gif.index].title} referrerPolicy="no-referrer" style={{ aspectRatio: `${gif.gifs[gif.index].width} / ${gif.gifs[gif.index].height}` }}
              className="mt-2 h-36 w-auto max-w-full rounded-md bg-zinc-100 object-cover"/>
            <div className="mt-2 flex items-center gap-1.5">
              <Button type="button" size="sm" autoFocus onClick={() => void sendGif()} className="h-7 px-2.5 text-xs">Send</Button>
              <Button type="button" size="sm" variant="outline" onClick={shuffleGif} disabled={gif.gifs.length < 2} className="h-7 gap-1 px-2.5 text-xs"><Shuffle size={12}/>Shuffle</Button>
              <Button type="button" size="sm" variant="ghost" onClick={closeGif} className="h-7 px-2.5 text-xs">Cancel</Button>
              <span className="ml-auto text-[10px] font-medium text-zinc-400">Powered by GIPHY</span>
            </div>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {uploads.map(item => (
              <div key={item.localId} className={cn("flex max-w-[220px] items-center gap-2 rounded-md border px-2 py-1 text-[11px]", item.state === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-zinc-200 bg-zinc-50 text-zinc-600")} title={item.error}>
                {item.state === "uploading" && <Loader2 size={12} className="shrink-0 animate-spin"/>}
                <span className="truncate font-medium">{item.fileName}</span>
                <span className="shrink-0 text-zinc-400">{item.state === "error" ? "failed" : item.state === "uploading" ? formatBytes(item.size) : "scanning"}</span>
                <button type="button" aria-label={`Remove ${item.fileName}`} onClick={() => setUploads(current => current.filter(other => other.localId !== item.localId))} className="shrink-0 rounded p-0.5 hover:bg-zinc-200"><X size={11}/></button>
              </div>
            ))}
          </div>
        )}
        <textarea ref={textareaRef} value={draft} maxLength={4000}
          // A command being typed is not a message, so it does not show as typing.
          onChange={event => { setDraft(event.target.value); setTyping(event.target.value.trim().length > 0 && !(onCommand && event.target.value.startsWith("/"))); updateMention(event.target.value, event.target.selectionStart); }}
          onKeyUp={event => { if (!MENTION_KEYS.has(event.key)) updateMention(event.currentTarget.value, event.currentTarget.selectionStart); }}
          onClick={event => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => { setTyping(false); setMention(null); }}
          role="combobox" aria-expanded={suggesting} aria-controls={suggesting ? `${listId}-mentions` : undefined} aria-autocomplete="list"
          aria-activedescendant={suggesting ? `${listId}-mention-${activeMention}` : undefined} onKeyDown={onKeyDown} onPaste={onPaste} rows={compact ? 1 : 2} placeholder={placeholder} aria-label={placeholder}
          className={cn("block max-h-48 w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-6 outline-none placeholder:text-zinc-400", compact ? "min-h-[44px]" : "min-h-[56px]")}/>
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="relative flex items-center gap-1">
            <input ref={fileRef} type="file" multiple hidden onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }}/>
            <button type="button" title="Attach files" aria-label="Attach files" onClick={() => fileRef.current?.click()} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><Paperclip size={16}/></button>
            <button type="button" title="Mention someone" aria-label="Mention someone" onClick={startMention} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><AtSign size={16}/></button>
            <button type="button" title="Emoji" aria-label="Insert emoji" onClick={() => setPicker(!picker)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><Smile size={16}/></button>
            {picker && <EmojiPicker className="bottom-11 left-0" onPick={insertEmoji} onClose={() => setPicker(false)}/>}
            {!compact && <span className="ml-2 hidden text-[11px] text-zinc-400 sm:inline"><kbd className="font-sans font-medium text-zinc-500">Enter</kbd> to send · <kbd className="font-sans font-medium text-zinc-500">Shift + Enter</kbd> for a new line{onCommand && <> · <kbd className="font-sans font-medium text-zinc-500">/</kbd> for commands</>}</span>}
          </div>
          <div className="relative flex items-center gap-1">
            {onSchedule && (
              <button type="button" disabled={!canSend || uploads.length > 0} onClick={() => setScheduling(!scheduling)} aria-expanded={scheduling}
                title={uploads.length ? "Messages with files can't be scheduled" : "Schedule message"} aria-label="Schedule message"
                className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:pointer-events-none disabled:opacity-40"><CalendarClock size={16}/></button>
            )}
            {scheduling && <WhenMenu title="Schedule message" submitLabel="Schedule" options={SCHEDULE_OPTIONS} onPick={at => void schedule(at)} onClose={() => setScheduling(false)} className="bottom-11 right-0"/>}
            <Button type="submit" size="icon" disabled={!canSend} title={uploading ? "Uploading…" : "Send"} aria-label={sending ? "Sending" : uploading ? "Uploading" : "Send"} className="h-8 w-8 rounded-lg">{sending || uploading ? <Loader2 size={14} className="animate-spin"/> : <ArrowUp size={16}/>}</Button>
          </div>
        </div>
      </form>
      <p aria-live="polite" className="mt-1 h-4 truncate px-1 text-[11px] text-zinc-400">{typingText}</p>
    </div>
  );
}
