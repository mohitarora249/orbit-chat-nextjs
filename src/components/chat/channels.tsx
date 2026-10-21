"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Check, Hash, Loader2, Lock, LogOut, Pencil, Plus, Search, UserMinus, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { dayLabel } from "@/components/chat/helpers";
import { api } from "@/lib/api";
import { presenceLabels, type Presence } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { ChannelMember, ChatUser, ConversationDetails, ConversationSummary } from "@/lib/types";

// Mirrors the server limits in src/lib/conversations.ts.
const MAX_TOPIC_LENGTH = 250;
const MAX_DESCRIPTION_LENGTH = 1000;

export type ChannelTab = "about" | "members";

// What the viewer may do; the server enforces the same rules (see requireChannel in src/lib/access.ts).
export function channelPermissions(conversation: ConversationSummary, meId: string, isWorkspaceAdmin: boolean) {
  const archived = Boolean(conversation.archivedAt);
  const canManage = conversation.createdById === meId || isWorkspaceAdmin;
  return {
    archived,
    canManage,
    canRename: canManage && !archived,
    canArchive: canManage,
    canEditInfo: (conversation.isMember || canManage) && !archived,
    canAddPeople: conversation.isMember && !archived,
    canRemovePeople: canManage && !archived
  };
}

function EditableField({ label, value, placeholder, prefix, multiline, maxLength, canEdit, onSave }: {
  label: string;
  value: string | null;
  placeholder: string;
  prefix?: string;
  multiline?: boolean;
  maxLength: number;
  canEdit: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (draft.trim() === (value ?? "")) { setEditing(false); return; }
    setSaving(true);
    try {
      if (await onSave(draft)) setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-lg border border-zinc-200 bg-card px-3 py-2 text-sm outline-none transition focus:border-brand-300 focus:ring-4 focus:ring-brand-100/60";
  return (
    <div className="border-b border-zinc-100 px-5 py-3.5 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium text-zinc-500">{label}</span>
        {canEdit && !editing && (
          <button onClick={() => { setDraft(value ?? ""); setEditing(true); }} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-brand-600 transition hover:bg-brand-50">
            <Pencil size={11}/>Edit
          </button>
        )}
      </div>
      {editing ? (
        <form onSubmit={event => { event.preventDefault(); void save(); }} className="mt-1.5 space-y-2">
          {multiline
            ? <textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} rows={4} maxLength={maxLength} placeholder={placeholder} aria-label={label}
                onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}
                className={cn(field, "resize-y")}/>
            : <div className="relative">
                {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">{prefix}</span>}
                <input autoFocus value={draft} onChange={event => setDraft(event.target.value)} maxLength={maxLength} placeholder={placeholder} aria-label={label}
                  onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }}
                  className={cn(field, prefix && "pl-7")}/>
              </div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] tabular-nums text-zinc-400">{draft.length}/{maxLength}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      ) : (
        <p className={cn("mt-1 whitespace-pre-wrap break-words text-sm leading-6", value ? "text-zinc-800" : "text-zinc-400")}>
          {value ? `${prefix ?? ""}${value}` : canEdit ? placeholder : "Not set"}
        </p>
      )}
    </div>
  );
}

// Channel details: name, topic, description, archive and leave ("About"), and the member list with add and
// remove controls ("Members").
export function ChannelDetailsDialog({ conversation, me, users, usersById, isWorkspaceAdmin, presenceOf, initialTab, onDetails, onJoin, onLeave, onOpenDm, onNotice, onClose }: {
  conversation: ConversationSummary;
  me: ChatUser;
  users: ChatUser[];
  usersById: Map<string, ChatUser>;
  isWorkspaceAdmin: boolean;
  presenceOf: (userId: string) => Presence;
  initialTab: ChannelTab;
  onDetails: (details: Partial<ConversationDetails> & { id: string }) => void;
  onJoin: () => Promise<boolean>;
  onLeave: () => Promise<boolean>;
  onOpenDm: (userId: string) => void;
  onNotice: (message: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ChannelTab>(initialTab);
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const permissions = channelPermissions(conversation, me.id, isWorkspaceAdmin);
  const id = conversation.id;

  // Refetched whenever the count changes, which covers joins and removals made by other people too.
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    api<{ members: ChannelMember[] }>(`/api/conversations/${id}/members`, { signal: controller.signal })
      .then(data => setMembers(data.members))
      .catch(error => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load members."); });
    return () => controller.abort();
  }, [id, conversation.memberCount]);

  async function patch(json: Record<string, unknown>, failure: string) {
    try {
      const { conversation: details } = await api<{ conversation: ConversationDetails }>(`/api/conversations/${id}`, { method: "PATCH", json });
      onDetails(details);
      return true;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : failure);
      return false;
    }
  }

  async function toggleArchive() {
    const archive = !permissions.archived;
    if (archive && !window.confirm(`Archive #${conversation.name}? It becomes read-only and leaves everyone's sidebar. Its history is kept, and it can be unarchived later.`)) return;
    setPending(true);
    if (await patch({ archived: archive }, archive ? "Could not archive channel." : "Could not unarchive channel.") && archive) onClose();
    setPending(false);
  }

  function applyMembers(next: ChannelMember[]) {
    setMembers(next);
    onDetails({ id, memberCount: next.length, ...(conversation.isPrivate ? { memberIds: next.map(member => member.userId) } : {}) });
  }

  async function addPeople() {
    if (!picked.length) return;
    setPending(true);
    try {
      const { members: next } = await api<{ members: ChannelMember[] }>(`/api/conversations/${id}/members`, { method: "POST", json: { userIds: picked } });
      applyMembers(next);
      onNotice(`Added ${picked.length === 1 ? usersById.get(picked[0])?.displayName ?? "1 person" : `${picked.length} people`} to #${conversation.name}.`);
      setPicked([]);
      setAdding(false);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not add people.");
    } finally {
      setPending(false);
    }
  }

  async function remove(userId: string) {
    const name = usersById.get(userId)?.displayName ?? "this person";
    if (!window.confirm(`Remove ${name} from #${conversation.name}?${conversation.isPrivate ? " They will no longer be able to see it." : ""}`)) return;
    try {
      await api(`/api/conversations/${id}/members/${userId}`, { method: "DELETE" });
      if (members) applyMembers(members.filter(member => member.userId !== userId));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not remove member.");
    }
  }

  async function leave() {
    setPending(true);
    try {
      if (await onLeave()) onClose();
    } finally {
      setPending(false);
    }
  }

  const memberSet = useMemo(() => new Set(members?.map(member => member.userId) ?? []), [members]);
  const q = query.trim().toLowerCase();
  const nameOf = (userId: string) => usersById.get(userId)?.displayName ?? "Unknown person";
  const visibleMembers = (members ?? [])
    .filter(member => nameOf(member.userId).toLowerCase().includes(q))
    .sort((a, b) => Number(b.userId === me.id) - Number(a.userId === me.id) || nameOf(a.userId).localeCompare(nameOf(b.userId)));
  const candidates = users.filter(user => !memberSet.has(user.id) && user.displayName.toLowerCase().includes(q));
  const creator = conversation.createdById ? usersById.get(conversation.createdById) : undefined;
  const Icon = conversation.isPrivate ? Lock : Hash;
  const tabClass = (active: boolean) => cn("relative h-10 px-1 text-[13px] font-medium transition", active ? "text-zinc-900 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-600" : "text-zinc-500 hover:text-zinc-800");

  return (
    <Dialog title={`#${conversation.name}`} onClose={onClose} className="max-w-lg">
      <div className="flex items-center gap-2 px-5 pt-3 text-[12px] text-zinc-500">
        <Icon size={12}/>{conversation.isPrivate ? "Private channel" : "Public channel"}
        {permissions.archived && <span className="rounded bg-zinc-100 px-1.5 py-px text-[11px] font-medium text-zinc-600">Archived</span>}
        {!conversation.isMember && <span className="rounded bg-zinc-100 px-1.5 py-px text-[11px] font-medium text-zinc-600">Not joined</span>}
      </div>
      <div role="tablist" className="flex gap-5 border-b border-zinc-100 px-5">
        <button role="tab" aria-selected={tab === "about"} onClick={() => setTab("about")} className={tabClass(tab === "about")}>About</button>
        <button role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")} className={tabClass(tab === "members")}>
          Members <span className="tabular-nums text-zinc-400">{conversation.memberCount}</span>
        </button>
      </div>

      {tab === "about" ? (
        <div>
          <EditableField label="Channel name" value={conversation.name} prefix="#" placeholder="e.g. plan-budget" maxLength={80} canEdit={permissions.canRename}
            onSave={name => patch({ name }, "Could not rename channel.")}/>
          <EditableField label="Topic" value={conversation.topic} placeholder="Add a topic" maxLength={MAX_TOPIC_LENGTH} canEdit={permissions.canEditInfo}
            onSave={topic => patch({ topic }, "Could not set the topic.")}/>
          <EditableField label="Description" value={conversation.description} placeholder="Add a description: what this channel is for" multiline maxLength={MAX_DESCRIPTION_LENGTH} canEdit={permissions.canEditInfo}
            onSave={description => patch({ description }, "Could not set the description.")}/>
          {creator && <p className="border-b border-zinc-100 px-5 py-3 text-[12px] text-zinc-500">Created by <span className="font-medium text-zinc-700">{creator.displayName}</span></p>}
          {permissions.archived && conversation.archivedAt && <p className="border-b border-zinc-100 px-5 py-3 text-[12px] text-zinc-500">Archived {dayLabel(conversation.archivedAt).toLowerCase()}. It is read-only until it is unarchived.</p>}
          <div className="flex flex-wrap items-center gap-2 bg-zinc-50/60 px-5 py-3.5">
            {!conversation.isMember && !permissions.archived && (
              <Button size="sm" disabled={pending} onClick={async () => { setPending(true); await onJoin(); setPending(false); }}><Plus size={14}/>Join channel</Button>
            )}
            {conversation.isMember && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void leave()} className="text-rose-600 hover:bg-rose-50"><LogOut size={14}/>Leave channel</Button>
            )}
            {permissions.canArchive && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void toggleArchive()} className="ml-auto">
                {permissions.archived ? <><ArchiveRestore size={14}/>Unarchive</> : <><Archive size={14}/>Archive channel</>}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="p-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-zinc-200 px-2.5 transition focus-within:border-brand-300 focus-within:ring-4 focus-within:ring-brand-100/60">
              <Search size={14} className="shrink-0 text-zinc-400"/>
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder={adding ? "Find people to add" : "Find members"} aria-label={adding ? "Find people to add" : "Find members"} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"/>
            </div>
            {permissions.canAddPeople && (
              adding
                ? <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setPicked([]); }}>Cancel</Button>
                : <Button size="sm" variant="outline" onClick={() => { setAdding(true); setQuery(""); }}><Plus size={14}/>Add people</Button>
            )}
          </div>

          <div className="mt-3 max-h-[46vh] space-y-0.5 overflow-y-auto">
            {loadError && <p className="px-2 py-3 text-xs text-rose-600">{loadError}</p>}
            {!members && !loadError && <div className="flex justify-center py-8 text-zinc-400"><Loader2 size={18} className="animate-spin"/></div>}
            {members && adding && (
              candidates.length === 0
                ? <p className="px-2 py-3 text-xs text-zinc-400">{q ? `No one else matches “${query.trim()}”.` : "Everyone in the workspace is already here."}</p>
                : candidates.map(user => {
                  const on = picked.includes(user.id);
                  return (
                    <button key={user.id} onClick={() => setPicked(current => on ? current.filter(item => item !== user.id) : [...current, user.id])}
                      className={cn("flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition", on ? "bg-brand-50" : "hover:bg-zinc-50")}>
                      <Avatar name={user.displayName} color={user.avatarColor} size="sm" presence={presenceOf(user.id)}/>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{user.displayName}</span>
                      {on && <Check size={14} className="text-brand-600"/>}
                    </button>
                  );
                })
            )}
            {members && !adding && visibleMembers.map(member => {
              const user = usersById.get(member.userId);
              const self = member.userId === me.id;
              return (
                <div key={member.userId} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-zinc-50">
                  <button onClick={() => onOpenDm(member.userId)} title={`Message ${nameOf(member.userId)}`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar name={nameOf(member.userId)} color={user?.avatarColor ?? "#A1A1AA"} size="sm" presence={presenceOf(member.userId)}/>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">
                        {nameOf(member.userId)}{self && <span className="font-normal text-zinc-400"> (you)</span>}
                        {member.userId === conversation.createdById && <span className="ml-1.5 rounded bg-zinc-100 px-1 py-px text-[10px] font-medium text-zinc-500">Creator</span>}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-400">{presenceLabels[presenceOf(member.userId)]} · joined {dayLabel(member.joinedAt).toLowerCase()}</span>
                    </span>
                  </button>
                  {self
                    ? <button onClick={() => void leave()} disabled={pending} className="rounded-md px-2 py-1 text-[12px] font-medium text-zinc-500 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100">Leave</button>
                    : permissions.canRemovePeople && (
                      <button onClick={() => void remove(member.userId)} title={`Remove ${nameOf(member.userId)}`} aria-label={`Remove ${nameOf(member.userId)}`}
                        className="rounded-md p-1.5 text-zinc-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"><UserMinus size={14}/></button>
                    )}
                </div>
              );
            })}
            {members && !adding && visibleMembers.length === 0 && <p className="px-2 py-3 text-xs text-zinc-400">{q ? `No members match “${query.trim()}”.` : "No members yet."}</p>}
          </div>

          {adding && (
            <div className="mt-3 flex items-center justify-end gap-2 border-t border-zinc-100 pt-3">
              <span className="mr-auto text-[11px] text-zinc-400">{picked.length ? `${picked.length} selected` : "Pick people to add"}</span>
              <Button size="sm" disabled={pending || !picked.length} onClick={() => void addPeople()}>{pending ? "Adding…" : "Add"}</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

// Every channel the viewer can see: joined ones, public ones they can preview or join, and archived ones.
export function BrowseChannelsDialog({ conversations, onOpen, onJoin, onCreate, onClose }: {
  conversations: ConversationSummary[];
  onOpen: (id: string) => void;
  onJoin: (id: string) => Promise<boolean>;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const channels = conversations
    .filter(c => c.type === "CHANNEL" && Boolean(c.archivedAt) === showArchived)
    .filter(c => !q || c.name.includes(q) || (c.topic ?? "").toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const archivedCount = conversations.filter(c => c.type === "CHANNEL" && c.archivedAt).length;

  async function join(id: string) {
    setJoining(id);
    try {
      if (await onJoin(id)) onOpen(id);
    } finally {
      setJoining(null);
    }
  }

  return (
    <Dialog title="Browse channels" onClose={onClose} className="max-w-xl">
      <div className="flex items-center gap-2.5 border-b border-zinc-100 px-4 py-3">
        <Search size={16} className="text-zinc-400"/>
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name, topic or description" aria-label="Search channels" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"/>
        {query && <button onClick={() => setQuery("")} aria-label="Clear search" className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={14}/></button>}
      </div>
      <div className="flex items-center gap-1 px-4 pt-3">
        {[false, true].map(archived => (
          <button key={String(archived)} onClick={() => setShowArchived(archived)} aria-pressed={showArchived === archived}
            className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium transition", showArchived === archived ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:text-zinc-800")}>
            {archived ? `Archived${archivedCount ? ` (${archivedCount})` : ""}` : "Channels"}
          </button>
        ))}
      </div>
      <div className="max-h-[55vh] overflow-y-auto p-2">
        {channels.length === 0 && (
          <p className="px-3 py-8 text-center text-xs text-zinc-400">{q ? `No channels match “${query.trim()}”.` : showArchived ? "No archived channels." : "No channels yet."}</p>
        )}
        {channels.map(channel => {
          const Icon = channel.isPrivate ? Lock : Hash;
          const about = channel.topic || channel.description;
          return (
            <div key={channel.id} className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition hover:bg-zinc-50">
              <button onClick={() => onOpen(channel.id)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                <Icon size={14} className="mt-[3px] shrink-0 text-zinc-400"/>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-zinc-900">{channel.name}</span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {channel.isMember && <span className="font-medium text-brand-600">Joined · </span>}
                    {channel.memberCount} {channel.memberCount === 1 ? "member" : "members"}{about && ` · ${about}`}
                  </span>
                </span>
              </button>
              {!channel.isMember && !channel.archivedAt
                ? <Button size="sm" variant="outline" disabled={joining !== null} onClick={() => void join(channel.id)}>{joining === channel.id ? "Joining…" : "Join"}</Button>
                : <Button size="sm" variant="ghost" onClick={() => onOpen(channel.id)} className="opacity-0 group-hover:opacity-100 focus:opacity-100">{channel.isMember ? "Open" : "View"}</Button>}
            </div>
          );
        })}
      </div>
      <div className="flex items-center border-t border-zinc-100 bg-zinc-50/60 px-4 py-2.5">
        <span className="text-[11px] text-zinc-400">Open a channel to preview it before joining.</span>
        <Button size="sm" variant="ghost" onClick={onCreate} className="ml-auto"><Plus size={14}/>Create a channel</Button>
      </div>
    </Dialog>
  );
}
