"use client";

import { Fragment, KeyboardEvent, memo, useState } from "react";
import { AlertTriangle, Download, FileText, Loader2, MessageSquareText, Pencil, ShieldAlert, SmilePlus, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { EmojiPicker } from "@/components/chat/emoji-picker";
import { dayLabel, isOptimistic, timeLabel } from "@/components/chat/helpers";
import { parseLinks } from "@/lib/links";
import { encodeMentions, mentionsMe, mentionsToText, mentionTargets, parseMentions } from "@/lib/mentions";
import { cn, formatBytes } from "@/lib/utils";
import type { ChatAttachment, ChatLinkPreview, ChatMessage, ChatUser } from "@/lib/types";

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type MessageActions = {
  onReact: (message: ChatMessage, emoji: string, add: boolean) => void;
  onEdit: (message: ChatMessage, body: string) => Promise<void>;
  onDelete: (message: ChatMessage) => void;
  onOpenThread?: (message: ChatMessage) => void;
};

type Props = MessageActions & {
  message: ChatMessage;
  grouped: boolean;
  me: ChatUser;
  canModerate: boolean;
  usersById: Map<string, ChatUser>;
  highlighted?: boolean;
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

// Renders text with mention tokens shown as the person's current name. Plain React text nodes only, never HTML.
function MessageBody({ body, usersById, meId }: { body: string; usersById: Map<string, ChatUser>; meId: string }) {
  return (
    <>
      {parseMentions(body).map((part, index) => {
        if (typeof part === "string") return <TextWithLinks key={index} text={part}/>;
        const forMe = part.kind !== "user" || part.userId === meId;
        const label = part.kind === "user" ? usersById.get(part.userId)?.displayName ?? "unknown user" : part.kind;
        return <span key={index} className={cn("rounded px-0.5 font-semibold", forMe ? "bg-amber-200/80 text-amber-950" : "bg-brand-50 text-brand-700")}>@{label}</span>;
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
  const className = "flex w-full max-w-xs items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 transition";
  return attachment.status === "CLEAN"
    ? <a href={href} className={cn(className, "hover:border-zinc-300 hover:bg-zinc-50")}>{content}</a>
    : <div className={className}>{content}</div>;
}

function LinkPreviewCard({ preview }: { preview: ChatLinkPreview }) {
  const [showImage, setShowImage] = useState(true);
  const site = preview.siteName ?? new URL(preview.url).hostname.replace(/^www\./, "");
  return (
    <a href={preview.url} target="_blank" rel={LINK_REL} className="flex w-full max-w-md gap-3 rounded-lg border border-l-[3px] border-zinc-200 border-l-zinc-300 bg-white px-3 py-2.5 transition hover:border-zinc-300 hover:border-l-brand-400 hover:bg-zinc-50">
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

function MessageItemImpl({ message, grouped, me, canModerate, usersById, highlighted, onReact, onEdit, onDelete, onOpenThread }: Props) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false);
  const pending = isOptimistic(message);
  const deleted = Boolean(message.deletedAt);
  const mine = message.authorId === me.id;
  const mentioned = !mine && !deleted && mentionsMe(message.body, me.id) !== null;

  // The edit box shows names; people already mentioned in the message win over others with the same name.
  function startEdit() {
    setEditDraft(mentionsToText(message.body, id => usersById.get(id)?.displayName, null));
    setEditing(true);
  }

  async function saveEdit() {
    const alreadyMentioned = parseMentions(message.body).flatMap(part => typeof part !== "string" && part.kind === "user" && usersById.has(part.userId) ? [usersById.get(part.userId)!] : []);
    const body = encodeMentions(editDraft.trim(), mentionTargets([...alreadyMentioned, ...usersById.values()], true));
    if (body === message.body) { setEditing(false); return; }
    setSaving(true);
    try {
      await onEdit(message, body);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function onEditKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit(); }
  }

  const reactionNames = (userIds: string[]) => userIds.map(id => id === me.id ? "You" : usersById.get(id)?.displayName ?? "Someone").join(", ");

  return (
    <div id={`message-${message.id}`} className={cn("group relative flex gap-3 rounded-lg px-2 py-1 transition-colors duration-150", grouped ? "" : "mt-4",
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
          <div className="mt-1 rounded-lg border border-zinc-200 bg-white p-2 shadow-float ring-2 ring-brand-100">
            <textarea autoFocus value={editDraft} onChange={event => setEditDraft(event.target.value)} onKeyDown={onEditKey} rows={2} maxLength={4000} aria-label="Edit message" className="w-full resize-y bg-transparent text-sm leading-6 outline-none"/>
            <div className="mt-1 flex items-center justify-end gap-2 text-[11px]">
              <span className="mr-auto text-zinc-400">Esc to cancel · Enter to save</span>
              <button onClick={() => setEditing(false)} className="rounded-md px-2 py-1 font-medium text-zinc-500 transition hover:bg-zinc-100">Cancel</button>
              <button onClick={() => void saveEdit()} disabled={saving} className="rounded-md bg-zinc-900 px-2.5 py-1 font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        ) : (
          message.body && (
            <p className={cn("whitespace-pre-wrap break-words text-sm leading-6 transition-colors", pending ? "text-zinc-400" : "text-zinc-800")}>
              <MessageBody body={message.body} usersById={usersById} meId={me.id}/>
              {message.editedAt && <span className="ml-1 text-[11px] text-zinc-400" title={`Edited ${dayLabel(message.editedAt)} at ${timeLabel(message.editedAt)}`}>(edited)</span>}
            </p>
          )
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
                <button key={reaction.emoji} onClick={() => onReact(message, reaction.emoji, !reacted)} title={`${reactionNames(reaction.userIds)} reacted with ${reaction.emoji}`}
                  className={cn("flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs transition active:scale-95", reacted ? "border-brand-200 bg-brand-50 text-brand-700" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50")}>
                  <span>{reaction.emoji}</span><span className="font-medium tabular-nums">{reaction.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {onOpenThread && message.replyCount > 0 && (
          <button onClick={() => onOpenThread(message)} className="-ml-1.5 mt-1 flex items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-brand-600 transition hover:bg-white hover:ring-1 hover:ring-zinc-200">
            <MessageSquareText size={14}/>{message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
            {message.lastReplyAt && <span className="font-normal text-zinc-400">Last reply {dayLabel(message.lastReplyAt).toLowerCase()} at {timeLabel(message.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      {!pending && !deleted && !editing && (
        <div className={cn("absolute -top-4 right-2 z-10 items-center gap-0.5 rounded-lg border border-zinc-200/80 bg-white p-0.5 shadow-float", picker ? "flex" : "hidden group-hover:flex group-focus-within:flex")}>
          <button title="Add reaction" aria-label="Add reaction" onClick={() => setPicker(true)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><SmilePlus size={15}/></button>
          {onOpenThread && <button title="Reply in thread" aria-label="Reply in thread" onClick={() => onOpenThread(message)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><MessageSquareText size={15}/></button>}
          {mine && <button title="Edit message" aria-label="Edit message" onClick={startEdit} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"><Pencil size={14}/></button>}
          {(mine || canModerate) && <button title="Delete message" aria-label="Delete message" onClick={() => onDelete(message)} className="rounded-md p-1.5 text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14}/></button>}
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
