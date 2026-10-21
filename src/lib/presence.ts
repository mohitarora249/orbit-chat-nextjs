// Presence is computed live from sockets (see server.ts): "active" if any of the person's tabs saw input
// recently, "away" if every tab has been idle for IDLE_AFTER_MS, "offline" with no sockets.
// Custom status and Do Not Disturb are stored on the user and broadcast as `status:update`.

export type Presence = "active" | "away" | "offline";

export const presenceLabels: Record<Presence, string> = { active: "Active", away: "Away", offline: "Offline" };

export const IDLE_AFTER_MS = 10 * 60 * 1000;

export const STATUS_TEXT_MAX = 100;

export type UserStatus = {
  emoji: string | null;
  text: string | null;
  // null: don't clear.
  expiresAt: string | null;
  dnd: boolean;
  // null with dnd: until turned off.
  dndUntil: string | null;
};

export const emptyStatus: UserStatus = { emoji: null, text: null, expiresAt: null, dnd: false, dndUntil: null };

const live = (until: string | null, now: number) => until === null || new Date(until).getTime() > now;

export function customStatus(status: UserStatus | undefined, now = Date.now()) {
  if (!status || (!status.emoji && !status.text) || !live(status.expiresAt, now)) return null;
  return { emoji: status.emoji, text: status.text, expiresAt: status.expiresAt };
}

export function isDnd(status: UserStatus | undefined, now = Date.now()) {
  return Boolean(status?.dnd && live(status.dndUntil, now));
}

type StatusColumns = { statusEmoji: string | null; statusText: string | null; statusExpiresAt: Date | null; dnd: boolean; dndUntil: Date | null };

export const statusSelect = { statusEmoji: true, statusText: true, statusExpiresAt: true, dnd: true, dndUntil: true } as const;

// Null when nothing is in effect, so clients only receive statuses that matter.
export function serializeStatus(user: StatusColumns, now = Date.now()): UserStatus | null {
  const status: UserStatus = {
    emoji: user.statusEmoji,
    text: user.statusText,
    expiresAt: user.statusExpiresAt?.toISOString() ?? null,
    dnd: user.dnd,
    dndUntil: user.dndUntil?.toISOString() ?? null
  };
  const custom = customStatus(status, now);
  const dnd = isDnd(status, now);
  if (!custom && !dnd) return null;
  return {
    ...(custom ? { emoji: custom.emoji, text: custom.text, expiresAt: custom.expiresAt } : { emoji: null, text: null, expiresAt: null }),
    dnd,
    dndUntil: dnd ? status.dndUntil : null
  };
}

// "3:30 PM", "tomorrow at 9:00 AM" or "Fri, Oct 24".
export function untilLabel(value: string, now = new Date()) {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}
