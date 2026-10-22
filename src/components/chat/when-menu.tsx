"use client";

import { FormEvent, useId, useState } from "react";
import { Popover } from "@/components/ui/overlay";
import { REMINDER_MAX_AHEAD_MS } from "@/lib/commands";
import { cn } from "@/lib/utils";

export type WhenOption = { label: string; at: () => Date };

// Times are worked out in the browser, in the user's time zone, when an option is picked.
export const inMinutes = (minutes: number): WhenOption["at"] => () => new Date(Date.now() + minutes * 60_000);

function atHour(daysAhead: number, hours: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hours, 0, 0, 0);
  return date;
}

export const tomorrowAt9: WhenOption["at"] = () => atHour(1, 9);
// The next Monday after today (a week from now on a Monday).
export const nextMondayAt9: WhenOption["at"] = () => atHour(((8 - new Date().getDay()) % 7) || 7, 9);

const shortTime = (at: Date) => new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);

// <input type="datetime-local"> wants local time without a zone: "2026-10-23T09:00".
function localInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A menu of quick times plus a custom date and time. `onPick` gets a time in the future, within a year.
export function WhenMenu({ title, options, submitLabel, onPick, onClose, className }: {
  title: string;
  options: WhenOption[];
  submitLabel: string;
  onPick: (at: Date) => void;
  onClose: () => void;
  className?: string;
}) {
  const [custom, setCustom] = useState(() => localInputValue(tomorrowAt9()));
  const [error, setError] = useState("");
  const inputId = useId();

  function submitCustom(event: FormEvent) {
    event.preventDefault();
    // Without a zone, Date parses it as local time.
    const at = new Date(custom);
    if (Number.isNaN(at.getTime())) return setError("Pick a date and time.");
    if (at.getTime() <= Date.now()) return setError("That time has already passed.");
    if (at.getTime() - Date.now() > REMINDER_MAX_AHEAD_MS) return setError("Pick a time within a year.");
    onPick(at);
  }

  return (
    <Popover onClose={onClose} className={cn("w-64 p-1", className)}>
      <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-zinc-400">{title}</p>
      <ul role="menu">
        {options.map(option => (
          <li key={option.label} role="none">
            <button type="button" role="menuitem" onClick={() => onPick(option.at())}
              className="flex h-8 w-full items-center justify-between gap-3 rounded-md px-2.5 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900">
              <span>{option.label}</span>
              <span className="text-[11px] tabular-nums text-zinc-400">{shortTime(option.at())}</span>
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submitCustom} className="mt-1 border-t border-zinc-100 px-2.5 pb-1.5 pt-2">
        <label className="text-[11px] font-medium text-zinc-400" htmlFor={inputId}>Custom time</label>
        <div className="mt-1 flex items-center gap-1.5">
          <input id={inputId} type="datetime-local" value={custom} min={localInputValue(new Date())} onChange={event => { setCustom(event.target.value); setError(""); }}
            className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-card px-2 py-1 text-xs outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"/>
          <button type="submit" className="shrink-0 rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-50 transition hover:bg-zinc-800">{submitLabel}</button>
        </div>
        {error && <p role="alert" className="mt-1 text-[11px] text-rose-600">{error}</p>}
      </form>
    </Popover>
  );
}
