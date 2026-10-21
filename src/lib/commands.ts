// Slash commands typed in the composer. Parsing runs in the browser, which knows the user's time zone, so
// "/remind me at 9am" means 9am where they are. No Node.js imports.

import { STATUS_TEXT_MAX } from "./presence";

export type SlashCommandName = "giphy" | "remind" | "status";

export const SLASH_COMMANDS: { name: SlashCommandName; usage: string; hint: string }[] = [
  // /giphy is turned off for now. Uncomment to bring it back (and set GIPHY_API_KEY).
  // { name: "giphy", usage: "/giphy [search]", hint: "Post a GIF" },
  { name: "remind", usage: "/remind me [what] [when]", hint: "Set a reminder for yourself; /remind list shows them" },
  { name: "status", usage: "/status [emoji] [text]", hint: "Set your status, or \"clear\"" }
];

export const REMINDER_TEXT_MAX = 500;
// Reminders, like statuses and Do Not Disturb, can be set at most this far ahead.
export const REMINDER_MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

// "/remind me to stretch in 20 min" -> { name: "remind", args: "me to stretch in 20 min" }.
// "//text" is not a command: it sends "/text".
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() } : null;
}

// ---- /remind -------------------------------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DAY = "today|tonight|tomorrow|tmrw|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?";
const TIME = "noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?";
const WHEN = [
  "in\\s+(?:an?|\\d+(?:\\.\\d+)?)\\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)",
  `(?:on\\s+)?(?:${DAY})(?:\\s+at\\s+(?:${TIME}))?`,
  `at\\s+(?:${TIME})(?:\\s+(?:on\\s+)?(?:${DAY}))?`
].join("|");
const WHEN_AT_END = new RegExp(`^([\\s\\S]*?)\\s+(${WHEN})\\.?$`, "i");
const WHEN_AT_START = new RegExp(`^(${WHEN})\\s+([\\s\\S]+)$`, "i");

// "5", "5pm", "17:30", "noon". Without am/pm, 1-11 o'clock means whichever of am and pm comes next.
function parseTime(text: string): { hours: number; minutes: number; ambiguous: boolean } | null {
  if (text === "noon") return { hours: 12, minutes: 0, ambiguous: false };
  if (text === "midnight") return { hours: 0, minutes: 0, ambiguous: false };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const meridiem = match[3];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "pm" ? 12 : 0);
    return { hours, minutes, ambiguous: false };
  }
  if (hours > 23) return null;
  return { hours, minutes, ambiguous: hours >= 1 && hours <= 11 };
}

function atTime(day: Date, hours: number, minutes: number) {
  const date = new Date(day);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function resolveWhen(when: string, now: Date): Date | string {
  const relative = /^in\s+(an?|\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(when);
  if (relative) {
    const amount = /^an?$/.test(relative[1]) ? 1 : Number(relative[1]);
    return new Date(now.getTime() + amount * UNIT_MS[relative[2][0]]);
  }
  const dayWord = new RegExp(`\\b(${DAY})\\b`).exec(when)?.[1];
  const timeText = new RegExp(`\\bat\\s+(${TIME})`).exec(when)?.[1];
  const time = timeText ? parseTime(timeText.replace(/\s+/g, "")) : null;
  if (timeText && !time) return `"${timeText}" isn't a time I understand.`;

  let day = new Date(now);
  let todayOnly = false;
  if (dayWord === "today" || dayWord === "tonight") todayOnly = true;
  else if (dayWord === "tomorrow" || dayWord === "tmrw") day.setDate(day.getDate() + 1);
  else if (dayWord) {
    // The next one after today: "on friday" said on a Friday means next week.
    const target = WEEKDAYS.indexOf(dayWord.slice(0, 3));
    day.setDate(day.getDate() + ((target - day.getDay() + 6) % 7) + 1);
  }

  if (!time) return atTime(day, dayWord === "tonight" ? 20 : 9, 0);
  // "tonight at 8" is 8pm; "tomorrow at 5" is 5pm, but "tomorrow at 8" is 8am.
  const hours = time.ambiguous && (dayWord === "tonight" || (dayWord !== undefined && time.hours <= 6)) ? time.hours + 12 : time.hours;
  let at = atTime(day, hours, time.minutes);
  if (time.ambiguous && dayWord === undefined && at <= now) at = atTime(day, hours + 12, time.minutes);
  if (at <= now) {
    if (todayOnly || dayWord !== undefined) return "That time has already passed.";
    // A bare "at 9am" that has passed today means tomorrow.
    day.setDate(day.getDate() + 1);
    at = atTime(day, hours, time.minutes);
  }
  return at;
}

export type ParsedReminder = { text: string; at: Date } | { error: string };

// "/remind me to stretch in 20 minutes", "/remind me tomorrow at 9am to call Sam", "/remind me at 5 standup".
export function parseReminder(args: string, now = new Date()): ParsedReminder {
  const input = args.trim().replace(/^me\b\s*/i, "");
  if (!input) return { error: "Try /remind me to stretch in 20 minutes." };
  const end = WHEN_AT_END.exec(input);
  const start = end ? null : WHEN_AT_START.exec(input);
  const what = end?.[1] ?? start?.[2];
  const when = end?.[2] ?? start?.[1];
  if (!what || !when) return { error: "Add when, like \"in 20 minutes\", \"at 3pm\" or \"tomorrow at 9am\"." };
  const text = what.trim().replace(/^(?:to|that|about)\s+/i, "").trim();
  if (!text) return { error: "Add what to remind you about." };
  if (text.length > REMINDER_TEXT_MAX) return { error: `Reminders can be up to ${REMINDER_TEXT_MAX} characters.` };
  const at = resolveWhen(when.toLowerCase().replace(/\s+/g, " "), now);
  if (typeof at === "string") return { error: at };
  if (at.getTime() <= now.getTime()) return { error: "That time has already passed." };
  if (at.getTime() - now.getTime() > REMINDER_MAX_AHEAD_MS) return { error: "Reminders can be set up to a year ahead." };
  return { text, at };
}

// "in 20 minutes" is clearer as "at 3:20 PM"; anything further reads as "tomorrow at 9:00 AM" or "on Fri, Oct 24 at 9:00 AM".
export function reminderTimeLabel(at: Date, now = new Date()) {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(at)} at ${time}`;
}

// ---- /status -------------------------------------------------------------------------------------------------

export type ParsedStatus = { kind: "open" } | { kind: "clear" } | { kind: "set"; emoji: string | null; text: string | null } | { kind: "error"; error: string };

// "/status 🌴 On vacation", "/status In a meeting", "/status clear". No arguments opens the status menu.
export function parseStatus(args: string): ParsedStatus {
  const input = args.trim();
  if (!input) return { kind: "open" };
  if (/^(clear|none|reset)$/i.test(input)) return { kind: "clear" };
  const first = new Intl.Segmenter().segment(input)[Symbol.iterator]().next().value?.segment ?? "";
  const emoji = /\p{Extended_Pictographic}/u.test(first) ? first : null;
  const text = (emoji ? input.slice(first.length) : input).trim() || null;
  if (text && text.length > STATUS_TEXT_MAX) return { kind: "error", error: `A status can be up to ${STATUS_TEXT_MAX} characters.` };
  return { kind: "set", emoji, text };
}
