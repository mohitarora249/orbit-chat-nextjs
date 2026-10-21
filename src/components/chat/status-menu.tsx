"use client";

import { FormEvent, useState } from "react";
import { BellOff, BellRing, Smile, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/overlay";
import { EmojiPicker } from "@/components/chat/emoji-picker";
import { customStatus, isDnd, presenceLabels, STATUS_TEXT_MAX, untilLabel, type Presence, type UserStatus } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { ChatUser } from "@/lib/types";

export type StatusPatch = {
  custom?: { emoji: string | null; text: string | null; expiresAt: string | null } | null;
  dnd?: { until: string | null } | null;
};

type Expiry = "never" | "30m" | "1h" | "4h" | "today" | "week";

const EXPIRY_LABELS: Record<Expiry, string> = { never: "Don't clear", "30m": "30 minutes", "1h": "1 hour", "4h": "4 hours", today: "Today", week: "This week" };

const PRESETS: { emoji: string; text: string; expiry: Expiry }[] = [
  { emoji: "📅", text: "In a meeting", expiry: "1h" },
  { emoji: "🚌", text: "Commuting", expiry: "30m" },
  { emoji: "🤒", text: "Out sick", expiry: "today" },
  { emoji: "🌴", text: "Vacationing", expiry: "never" },
  { emoji: "🏡", text: "Working remotely", expiry: "today" }
];

const endOfDay = (date: Date) => { const end = new Date(date); end.setHours(23, 59, 59, 999); return end; };

function expiryTime(expiry: Expiry): string | null {
  const now = new Date();
  const minutes = { "30m": 30, "1h": 60, "4h": 240 } as Record<Expiry, number | undefined>;
  if (expiry === "never") return null;
  if (minutes[expiry]) return new Date(now.getTime() + minutes[expiry]! * 60_000).toISOString();
  if (expiry === "today") return endOfDay(now).toISOString();
  // End of Sunday.
  const sunday = new Date(now);
  sunday.setDate(now.getDate() + ((7 - now.getDay()) % 7));
  return endOfDay(sunday).toISOString();
}

function tomorrowMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

const DND_OPTIONS: { label: string; until: () => string | null }[] = [
  { label: "30 minutes", until: () => new Date(Date.now() + 30 * 60_000).toISOString() },
  { label: "1 hour", until: () => new Date(Date.now() + 60 * 60_000).toISOString() },
  { label: "2 hours", until: () => new Date(Date.now() + 120 * 60_000).toISOString() },
  { label: "Until tomorrow", until: tomorrowMorning },
  { label: "Until I turn it off", until: () => null }
];

export function StatusMenu({ me, status, presence, onSave, onClose }: {
  me: ChatUser;
  status: UserStatus | undefined;
  presence: Presence;
  onSave: (patch: StatusPatch) => Promise<boolean>;
  onClose: () => void;
}) {
  const current = customStatus(status);
  const dnd = isDnd(status);
  const [editing, setEditing] = useState(!current);
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  const [text, setText] = useState(current?.text ?? "");
  const [expiry, setExpiry] = useState<Expiry>("today");
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(patch: StatusPatch) {
    setSaving(true);
    const ok = await onSave(patch);
    setSaving(false);
    return ok;
  }

  async function submitCustom(event: FormEvent) {
    event.preventDefault();
    if (!emoji && !text.trim()) return;
    if (await save({ custom: { emoji: emoji || "💬", text: text.trim() || null, expiresAt: expiryTime(expiry) } })) setEditing(false);
  }

  const chip = "rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50";

  return (
    <Popover onClose={onClose} className="bottom-full left-2 right-2 mb-2 p-3 text-xs">
      <div className="flex items-center gap-2.5">
        <Avatar name={me.displayName} color={me.avatarColor} presence={presence} dnd={dnd}/>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{me.displayName}</div>
          <div className="text-[11px] text-zinc-500">{presenceLabels[presence]}{presence === "away" && " · no activity for a while"}</div>
        </div>
      </div>

      <section className="mt-3 border-t border-zinc-100 pt-3">
        <h3 className="text-[11px] font-medium text-zinc-400">Status</h3>
        {!editing && current ? (
          <div className="mt-1.5 flex items-start gap-2">
            <span className="text-base leading-5">{current.emoji}</span>
            <div className="min-w-0 flex-1">
              <div className="break-words text-[13px] text-zinc-800">{current.text}</div>
              <div className="text-[11px] text-zinc-400">{current.expiresAt ? `Until ${untilLabel(current.expiresAt)}` : "Doesn't clear"}</div>
            </div>
            <button onClick={() => setEditing(true)} className="rounded px-1.5 py-0.5 font-medium text-brand-600 hover:bg-brand-50">Edit</button>
            <button onClick={() => void save({ custom: null }).then(ok => { if (ok) { setEmoji(""); setText(""); setEditing(true); } })} disabled={saving} title="Clear status" aria-label="Clear status" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X size={13}/></button>
          </div>
        ) : (
          <form onSubmit={submitCustom} className="mt-1.5">
            <div className="relative flex h-8 items-center gap-1 rounded-md border border-zinc-200 bg-card pl-1 pr-2 focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100">
              <button type="button" onClick={() => setPicker(!picker)} title="Choose an emoji" aria-label="Choose an emoji" className="flex h-6 w-6 items-center justify-center rounded text-base hover:bg-zinc-100">
                {emoji || <Smile size={14} className="text-zinc-400"/>}
              </button>
              <input value={text} onChange={event => setText(event.target.value)} maxLength={STATUS_TEXT_MAX} placeholder="What's your status?" aria-label="Status text" autoFocus
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-zinc-400"/>
              {picker && <EmojiPicker className="bottom-9 left-0" onPick={value => { setEmoji(value); setPicker(false); }} onClose={() => setPicker(false)}/>}
            </div>
            {!text && !emoji && (
              <div className="mt-1.5 space-y-0.5">
                {PRESETS.map(preset => (
                  <button key={preset.text} type="button" onClick={() => { setEmoji(preset.emoji); setText(preset.text); setExpiry(preset.expiry); }}
                    className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-zinc-700 hover:bg-zinc-100">
                    <span>{preset.emoji}</span>{preset.text}<span className="ml-auto text-[11px] text-zinc-400">{EXPIRY_LABELS[preset.expiry]}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-zinc-500">
                Clear after
                <select value={expiry} onChange={event => setExpiry(event.target.value as Expiry)} className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-card px-1.5 py-1 text-[11px] text-zinc-700 outline-none focus:border-brand-300">
                  {(Object.keys(EXPIRY_LABELS) as Expiry[]).map(key => <option key={key} value={key}>{EXPIRY_LABELS[key]}</option>)}
                </select>
              </label>
              {current && <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2 py-1 font-medium text-zinc-500 hover:bg-zinc-100">Cancel</button>}
              <Button type="submit" size="sm" disabled={saving || (!emoji && !text.trim())} className="h-7 px-2.5 text-[11px]">Save</Button>
            </div>
          </form>
        )}
      </section>

      <section className="mt-3 border-t border-zinc-100 pt-3">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400"><BellOff size={12}/>Do not disturb</h3>
        {dnd ? (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="flex-1 text-[12px] text-zinc-700">Notifications paused {status?.dndUntil ? `until ${untilLabel(status.dndUntil)}` : "until you turn them back on"}.</span>
            <button onClick={() => void save({ dnd: null })} disabled={saving} className={cn(chip, "flex items-center gap-1 text-brand-700")}><BellRing size={12}/>Resume</button>
          </div>
        ) : (
          <>
            <p className="mt-1 text-[11px] text-zinc-500">No desktop notifications, sounds or mention pop-ups. Unread badges still count.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DND_OPTIONS.map(option => <button key={option.label} disabled={saving} onClick={() => void save({ dnd: { until: option.until() } })} className={chip}>{option.label}</button>)}
            </div>
          </>
        )}
      </section>
    </Popover>
  );
}
