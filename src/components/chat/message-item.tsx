"use client";

import { Fragment, KeyboardEvent, memo, useEffect, useRef, useState } from "react";
import { AlarmClock, AlertTriangle, CloudOff, Download, FileText, Forward, Hash, Loader2, Lock, MessageSquareText, Pencil, ShieldAlert, SmilePlus, Trash2, User } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { EmojiPicker } from "@/components/chat/emoji-picker";
import { PollCard } from "@/components/chat/poll";
import { inMinutes, nextMondayAt9, tomorrowAt9, WhenMenu, type WhenOption } from "@/components/chat/when-menu";
import { dayLabel, isOptimistic, timeLabel } from "@/components/chat/helpers";
import type { MessageOp } from "@/components/chat/pending";
import { isGifUrl, parseLinks } from "@/lib/links";
import { encodeMentions, mentionsMe, mentionsToText, mentionTargets, parseMentions } from "@/lib/mentions";
import { cn, formatBytes } from "@/lib/utils";
import type { ChatAttachment, ChatForward, ChatLinkPreview, ChatMessage, ChatUser, MessageAction } from "@/lib/types";

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type MessageActions = {
  onReact: (message: ChatMessage, emoji: string, add: boolean) => void;
  onEdit: (message: ChatMessage, body: string) => void;
  onDelete: (message: ChatMessage) => void;
  // Sends a failed change again, or gives up on it (discarding an unsent message, undoing an unsaved edit).
  onRetry: (op: MessageOp) => void;
  onDismiss: (op: MessageOp) => void;
  onOpenThread?: (message: ChatMessage) => void;
  onForward: (message: ChatMessage) => void;
  // Votes in or closes a poll.
  onAction: (message: ChatMessage, action: MessageAction) => void;
  // "Remind me about this": sets a personal reminder that links back to the message.
  onRemind: (message: ChatMessage, at: Date) => void;
  // Jumps to the original of a forwarded message; returns null if the viewer cannot see its conversation.
  openForwarded: (forward: ChatForward) => (() => void) | null;
  // Called when a message starts editing because `editRequested` was set, so the request is not repeated.
  onEditRequestHandled?: () => void;
};

type Props = MessageActions & {
  // Shown with its unconfirmed changes applied; `ops` lists them, so failures can be shown and retried.
  message: ChatMessage;
  ops?: MessageOp[];
  grouped: boolean;
  me: ChatUser;
  canModerate: boolean;
  usersById: Map<string, ChatUser>;
  // "Ana is replying…" while someone types in this message's thread (main list only).
  replyTyping?: string | null;
  highlighted?: boolean;
  // In an archived channel: no reacting or editing (deleting is still allowed).
  readOnly?: boolean;
  // ↑ in the composer asked to edit this message.
  editRequested?: boolean;
};

// Links open in a new tab without telling the site where they came from. parseLinks only yields http(s) URLs.
const LINK_REL = "noopener noreferrer nofollow";

function TextWithLinks({ text }: { text: string }) {
  return (
    <>
      {parseLinks(text).map((part, index) => typeof part === "string"
        ? <Fragment key={index}>{part}</Fragment>
        : <a key={index} href={part.url} target="_blank" rel={LINK_REL} className="text-brand-600 underline decoration-brand-200 underline-offset-2 transition hover:decoration-brand-500">{part.url}</a>)}
    </>
  );
}

// A GIF posted with /giphy. The body is only its URL, so it is shown as the image.
function GifView({ url }: { url: string }) {
  return (
    <span className="block w-fit">
      {/* eslint-disable-next-line @next/next/no-img-element -- GIFs are served by GIPHY; no-referrer keeps the conversation URL private */}
      <img src={url} alt="GIF" loading="lazy" referrerPolicy="no-referrer" className="h-40 w-auto max-w-full rounded-lg bg-zinc-100 object-cover"/>
      <span className="mt-0.5 block text-[10px] font-medium text-zinc-400">via GIPHY</span>
    </span>
  );
}

// Renders text with mention tokens shown as the person's current name. Plain React text nodes only, never HTML.
function MessageBody({ body, usersById, meId }: { body: string; usersById: Map<string, ChatUser>; meId: string }) {
  return (
    <>
      {parseMentions(body).map((part, index) => {
        if (typeof part === "string") return <TextWithLinks key={index} text={part}/>;
        const forMe = part.kind !== "user" || part.userId === meId;
        const label = part.kind === "user" ? usersById.get(part.userId)?.displayName ?? "unknown user" : part.kind;
        return <span key={index} className={cn("rounded px-0.5 font-semibold", forMe ? "bg-amber-200/80 text-amber-900" : "bg-brand-50 text-brand-700")}>@{label}</span>;
      })}
    </>
  );
}

function AttachmentView({ attachment }: { attachment: ChatAttachment }) {
  const href = `/api/attachments/${attachment.id}`;
  if (attachment.status === "CLEAN" && INLINE_IMAGE_TYPES.has(attachment.contentType)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block w-fit overflow-hidden rounded-lg border border-zinc-200 transition hover:opacity-95">
        {/* eslint-disable-next-line @next/next/no-img-element -- served via a short-lived presigned redirect */}
        <img src={href} alt={attachment.fileName} className="max-h-64 max-w-full object-contain"/>
      </a>
    );
  }
  const state = {
    CLEAN: { icon: <FileText size={18} className="text-zinc-500"/>, note: formatBytes(attachment.size) },
    SCANNING: { icon: <Loader2 size={18} className="animate-spin text-zinc-400"/>, note: "Scanning for malware…" },
    PENDING_UPLOAD: { icon: <Loader2 size={18} className="animate-spin text-zinc-400"/>, note: "Uploading…" },
    INFECTED: { icon: <ShieldAlert size={18} className="text-rose-600"/>, note: "Blocked: malware detected" },
    FAILED: { icon: <AlertTriangle size={18} className="text-amber-600"/>, note: "Upload or scan failed" }
  }[attachment.status];
  const content = (
    <>
      {state.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-zinc-800">{attachment.fileName}</span>
        <span className={cn("block text-[11px]", attachment.status === "INFECTED" ? "text-rose-600" : "text-zinc-400")}>{state.note}</span>
      </span>
      {attachment.status === "CLEAN" && <Download size={14} className="text-zinc-400"/>}
    </>
  );
  const className = "flex w-full max-w-xs items-center gap-3 rounded-lg border border-zinc-200 bg-card px-3 py-2 transition";
  return attachment.status === "CLEAN"
    ? <a href={href} className={cn(className, "hover:border-zinc-300 hover:bg-zinc-50")}>{content}</a>
    : <div className={className}>{content}</div>;
}

function LinkPreviewCard({ preview }: { preview: ChatLinkPreview }) {
  const [showImage, setShowImage] = useState(true);
  const site = preview.siteName ?? new URL(preview.url).hostname.replace(/^www\./, "");
  return (
    <a href={preview.url} target="_blank" rel={LINK_REL} className="flex w-full max-w-md gap-3 rounded-lg border border-l-[3px] border-zinc-200 border-l-zinc-300 bg-card px-3 py-2.5 transition hover:border-zinc-300 hover:border-l-brand-400 hover:bg-zinc-50">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-zinc-400">{site}</span>
        {preview.title && <span className="line-clamp-2 text-[13px] font-semibold leading-5 text-brand-700">{preview.title}</span>}
        {preview.description && <span className="mt-0.5 line-clamp-3 text-xs leading-5 text-zinc-600">{preview.description}</span>}
      </span>
      {preview.imageUrl && showImage && (
        // eslint-disable-next-line @next/next/no-img-element -- third-party image; no-referrer keeps the conversation URL private
        <img src={preview.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setShowImage(false)} className="h-16 w-16 shrink-0 rounded-md bg-zinc-100 object-cover"/>
      )}
    </a>
  );
}

export function forwardSourceLabel(forward: Pick<ChatForward, "conversation">) {
  const { type, isPrivate, name } = forward.conversation;
  return type === "DM" ? "a direct message" : isPrivate || !name ? "a private channel" : `#${name}`;
}

// The quoted original of a forwarded message.
export function ForwardedCard({ forward, usersById, me, onOpen }: { forward: ChatForward; usersById: Map<string, ChatUser>; me: ChatUser; onOpen?: (() => void) | null }) {
  const SourceIcon = forward.conversation.type === "DM" ? User : forward.conversation.isPrivate ? Lock : Hash;
  const source = forwardSourceLabel(forward);
  return (
    <div className="mt-1 w-full max-w-xl rounded-lg border border-l-[3px] border-zinc-200 border-l-brand-300 bg-zinc-50/60 px-3 py-2">
      {forward.deleted ? (
        <p className="text-[13px] italic leading-5 text-zinc-400">The original message was deleted.</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Avatar name={forward.author.displayName} color={forward.author.avatarColor} size="sm"/>
            <span className="truncate text-[13px] font-semibold text-zinc-900">{forward.author.displayName}</span>
          </div>
          {forward.body && isGifUrl(forward.body) && <div className="mt-1"><GifView url={forward.body}/></div>}
          {forward.body && !isGifUrl(forward.body) && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-800">
              <MessageBody body={forward.body} usersById={usersById} meId={me.id}/>
              {forward.editedAt && <span className="ml-1 text-[11px] text-zinc-400" title={`Edited ${dayLabel(forward.editedAt)} at ${timeLabel(forward.editedAt)}`}>(edited)</span>}
            </p>
          )}
          {forward.poll && <PollCard poll={forward.poll} me={me} usersById={usersById} interactive={false}/>}
          {forward.attachments.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-2">{forward.attachments.map(attachment => <AttachmentView key={attachment.id} attachment={attachment}/>)}</div>
          )}
        </>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-400">
        <SourceIcon size={11} className="shrink-0"/>
        <span>{forward.parentId ? `Thread in ${source}` : `Posted in ${source}`}</span>
        <span aria-hidden>·</span>
        <time dateTime={forward.createdAt}>{dayLabel(forward.createdAt)} at {timeLabel(forward.createdAt)}</time>
        {onOpen && !forward.deleted && <><span aria-hidden>·</span><button onClick={onOpen} className="font-medium text-brand-600 transition hover:text-brand-700 hover:underline">View message</button></>}
      </div>
    </div>
  );
}

const REMIND_OPTIONS: WhenOption[] = [
  { label: "In 20 minutes", at: inMinutes(20) },
  { label: "In 1 hour", at: inMinutes(60) },
  { label: "In 3 hours", at: inMinutes(180) },
  { label: "Tomorrow morning", at: tomorrowAt9 },
  { label: "Next Monday morning", at: nextMondayAt9 }
];

const failureLabels: Record<MessageOp["kind"], { what: (op: MessageOp) => string; dismiss: string }> = {
  send: { what: () => "Not sent", dismiss: "Delete" },
  edit: { what: () => "Edit not saved", dismiss: "Undo edit" },
  delete: { what: () => "Couldn't delete", dismiss: "Dismiss" },
  vote: { what: () => "Vote not saved", dismiss: "Dismiss" },
  react: { what: op => op.kind === "react" ? `Couldn't ${op.add ? "add" : "remove"} ${op.emoji}` : "", dismiss: "Dismiss" }
};

function FailedOps({ ops, onRetry, onDismiss }: { ops: MessageOp[]; onRetry: (op: MessageOp) => void; onDismiss: (op: MessageOp) => void }) {
  return (
    <div role="alert" className="mt-1 space-y-0.5">
      {ops.map(op => (
        <p key={op.key} className="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-5 text-rose-600">
          <AlertTriangle size={12} className="shrink-0"/>
          <span className="font-medium">{failureLabels[op.kind].what(op)}.</span>
          {op.error && <span className="text-zinc-500">{op.error}</span>}
          <button onClick={() => onRetry(op)} className="font-semibold underline-offset-2 transition hover:underline">Retry</button>
          <span aria-hidden className="text-zinc-300">·</span>
          <button onClick={() => onDismiss(op)} className="font-medium text-zinc-500 underline-offset-2 transition hover:text-zinc-700 hover:underline">{failureLabels[op.kind].dismiss}</button>
        </p>
      ))}
    </div>
  );
}

function MessageItemImpl({ message, ops, grouped, me, canModerate, usersById, highlighted, replyTyping, readOnly, editRequested, onReact, onEdit, onDelete, onRetry, onDismiss, onOpenThread, onForward, onAction, onRemind, openForwarded, onEditRequestHandled }: Props) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [picker, setPicker] = useState(false);
  const [remindMenu, setRemindMenu] = useState(false);
  const pending = isOptimistic(message);
  const failed = ops?.filter(op => op.status === "failed") ?? [];
  const queued = ops?.find(op => op.kind === "send" && op.status === "pending" && op.network);
  const savingEdit = ops?.some(op => op.kind === "edit" && op.status === "pending");
  const pendingEmoji = new Set(ops?.flatMap(op => op.kind === "react" && op.status === "pending" ? [op.emoji] : []));
  const deleted = Boolean(message.deletedAt);
  const mine = message.authorId === me.id;
  const mentioned = !mine && !deleted && mentionsMe(message.body, me.id) !== null;

  // Where focus goes back to when editing ends: the composer, when ↑ started the edit.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The edit box shows names; people already mentioned in the message win over others with the same name.
  function startEdit() {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditDraft(mentionsToText(message.body, id => usersById.get(id)?.displayName, null));
    setEditing(true);
  }

  function stopEdit() {
    setEditing(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }

  const canEdit = mine && !readOnly && !pending && !deleted && !isGifUrl(message.body);
  useEffect(() => {
    if (!editRequested) return;
    onEditRequestHandled?.();
    if (!canEdit || editing) return;
    startEdit();
    rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [editRequested]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new request starts an edit

  function saveEdit() {
    const alreadyMentioned = parseMentions(message.body).flatMap(part => typeof part !== "string" && part.kind === "user" && usersById.has(part.userId) ? [usersById.get(part.userId)!] : []);
    const body = encodeMentions(editDraft.trim(), mentionTargets([...alreadyMentioned, ...usersById.values()], true));
    // Shows at once; a failed save keeps the new text with a retry below the message.
    if (body !== message.body) onEdit(message, body);
    stopEdit();
  }

  function onEditKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") { event.preventDefault(); stopEdit(); }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); saveEdit(); }
  }

  const reactionNames = (userIds: string[]) => userIds.map(id => id === me.id ? "You" : usersById.get(id)?.displayName ?? "Someone").join(", ");

  return (
    <div ref={rootRef} id={`message-${message.id}`} className={cn("group relative flex gap-3 rounded-lg px-2 py-1 transition-colors duration-150", grouped ? "" : "mt-4",
      highlighted ? "bg-brand-50 ring-1 ring-brand-200" : mentioned ? "rounded-l-none bg-amber-50/80 shadow-[inset_3px_0_0_theme(colors.amber.400)] hover:bg-amber-50" : "hover:bg-zinc-50/80")}>
      <div className="w-9 shrink-0">
        {grouped
          ? <span className="block pt-[3px] text-right text-[10px] tabular-nums leading-5 text-zinc-400 opacity-0 transition group-hover:opacity-100">{timeLabel(message.createdAt)}</span>
          : <Avatar name={message.author.displayName} color={message.author.avatarColor}/>}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold tracking-tight text-zinc-900">{message.author.displayName}</span>
            <time dateTime={message.createdAt} title={`${dayLabel(message.createdAt)} at ${timeLabel(message.createdAt)}`} className="text-[11px] tabular-nums text-zinc-400">{timeLabel(message.createdAt)}</time>
          </div>
        )}
        {deleted ? (
          <p className="text-sm italic leading-6 text-zinc-400">This message was deleted.</p>
        ) : editing ? (
          <div className="mt-1 rounded-lg border border-zinc-200 bg-card p-2 shadow-float ring-2 ring-brand-100">
            <textarea autoFocus value={editDraft} onFocus={event => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)} onChange={event => setEditDraft(event.target.value)} onKeyDown={onEditKey} rows={2} maxLength={4000} aria-label="Edit message" className="w-full resize-y bg-transparent text-sm leading-6 outline-none"/>
            <div className="mt-1 flex items-center justify-end gap-2 text-[11px]">
              <span className="mr-auto text-zinc-400">Esc to cancel · Enter to save</span>
              <button onClick={stopEdit} className="rounded-md px-2 py-1 font-medium text-zinc-500 transition hover:bg-zinc-100">Cancel</button>
              <button onClick={saveEdit} className="rounded-md bg-zinc-900 px-2.5 py-1 font-medium text-zinc-50 transition hover:bg-zinc-800">Save</button>
            </div>
          </div>
        ) : isGifUrl(message.body) ? (
          <div className="mt-0.5"><GifView url={message.body}/></div>
        ) : (
          message.body && (
            <p className={cn("whitespace-pre-wrap break-words text-sm leading-6 transition-colors", pending ? "text-zinc-400" : "text-zinc-800")}>
              <MessageBody body={message.body} usersById={usersById} meId={me.id}/>
              {savingEdit
                ? <span className="ml-1 text-[11px] text-zinc-400">(saving…)</span>
                : message.editedAt && <span className="ml-1 text-[11px] text-zinc-400" title={`Edited ${dayLabel(message.editedAt)} at ${timeLabel(message.editedAt)}`}>(edited)</span>}
            </p>
          )
        )}
        {!deleted && message.forwarded && (
          <>
            {!message.body && <p className="flex items-center gap-1 text-xs text-zinc-400"><Forward size={12}/>Forwarded a message</p>}
            <ForwardedCard forward={message.forwarded} usersById={usersById} me={me} onOpen={openForwarded(message.forwarded)}/>
          </>
        )}
        {!deleted && message.poll && (
          <PollCard poll={message.poll} me={me} usersById={usersById} interactive={!readOnly && !pending} canManage={mine || canModerate}
            onVote={optionIds => onAction(message, { action: "poll.vote", optionIds })} onClosePoll={() => onAction(message, { action: "poll.close" })}
            onReopen={closesAt => onAction(message, { action: "poll.reopen", closesAt })}/>
        )}
        {!deleted && !editing && message.linkPreviews.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-2">{message.linkPreviews.map(preview => <LinkPreviewCard key={preview.url} preview={preview}/>)}</div>
        )}
        {!deleted && message.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-2">{message.attachments.map(attachment => <AttachmentView key={attachment.id} attachment={attachment}/>)}</div>
        )}
        {!deleted && message.reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {message.reactions.map(reaction => {
              const reacted = reaction.userIds.includes(me.id);
              return (
                <button key={reaction.emoji} disabled={readOnly} onClick={() => onReact(message, reaction.emoji, !reacted)} title={`${reactionNames(reaction.userIds)} reacted with ${reaction.emoji}`}
                  className={cn("flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs transition active:scale-95", pendingEmoji.has(reaction.emoji) && "opacity-60", reacted ? "border-brand-200 bg-brand-50 text-brand-700" : "border-zinc-200 bg-card text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50")}>
                  <span>{reaction.emoji}</span><span className="font-medium tabular-nums">{reaction.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {failed.length > 0 && !editing && <FailedOps ops={failed} onRetry={onRetry} onDismiss={onDismiss}/>}
        {queued && (
          <p role="status" className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-5 text-zinc-500">
            <CloudOff size={12} className="shrink-0"/>
            <span className="font-medium">Waiting for connection.</span>
            <span className="text-zinc-400">Sends when you're back online.</span>
            <button onClick={() => onDismiss(queued)} className="font-medium underline-offset-2 transition hover:text-zinc-700 hover:underline">Delete</button>
          </p>
        )}
        {onOpenThread && (message.replyCount > 0 || replyTyping) && (
          <button onClick={() => onOpenThread(message)} className="-ml-1.5 mt-1 flex items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-brand-600 transition hover:bg-card hover:ring-1 hover:ring-zinc-200">
            <MessageSquareText size={14}/>{message.replyCount > 0 ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}` : "Thread"}
            {replyTyping
              ? <span aria-live="polite" className="font-normal italic text-zinc-500">{replyTyping}</span>
              : message.lastReplyAt && <span className="font-normal text-zinc-400">Last reply {dayLabel(message.lastReplyAt).toLowerCase()} at {timeLabel(message.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {!pending && !deleted && !editing && (
        <div className={cn("absolute -top-4 right-2 z-10 items-center gap-0.5 rounded-lg border border-zinc-200/80 bg-card p-0.5 shadow-float", picker || remindMenu ? "flex" : "hidden group-hover:flex group-focus-within:flex")}>
          {!readOnly && <button title="Add reaction" aria-label="Add reaction" onClick={() => setPicker(true)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><SmilePlus size={15}/></button>}
          {onOpenThread && <button title="Reply in thread" aria-label="Reply in thread" onClick={() => onOpenThread(message)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><MessageSquareText size={15}/></button>}
          <button title="Forward message" aria-label="Forward message" onClick={() => onForward(message)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><Forward size={15}/></button>
          <button title="Remind me about this" aria-label="Remind me about this" aria-expanded={remindMenu} onClick={() => setRemindMenu(!remindMenu)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><AlarmClock size={15}/></button>
          {mine && !readOnly && !isGifUrl(message.body) && <button title="Edit message" aria-label="Edit message" onClick={startEdit} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><Pencil size={14}/></button>}
          {(mine || canModerate) && <button title="Delete message" aria-label="Delete message" onClick={() => onDelete(message)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14}/></button>}
          {remindMenu && (
            <WhenMenu title="Remind me about this" submitLabel="Remind me" options={REMIND_OPTIONS} className="right-0 top-8" onClose={() => setRemindMenu(false)}
              onPick={at => { setRemindMenu(false); onRemind(message, at); }}/>
          )}
          {picker && (
            <EmojiPicker className="right-0 top-8" onClose={() => setPicker(false)} onPick={emoji => {
              setPicker(false);
              const existing = message.reactions.find(reaction => reaction.emoji === emoji);
              onReact(message, emoji, !existing?.userIds.includes(me.id));
            }}/>
          )}
        </div>
      )}
    </div>
  );
}

export const MessageItem = memo(MessageItemImpl);
