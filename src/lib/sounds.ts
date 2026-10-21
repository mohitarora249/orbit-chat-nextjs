// Notification sounds synthesized with the Web Audio API: no audio assets, so nothing to license or ship.

export type SoundKind = "message" | "mention";

type Note = { frequency: number; at: number; duration: number; gain: number };

const SOUNDS: Record<SoundKind, Note[]> = {
  // A single soft, short blip for ordinary incoming messages.
  message: [{ frequency: 880, at: 0, duration: 0.12, gain: 0.08 }],
  // A brighter two-note rising chime for direct messages and @mentions.
  mention: [
    { frequency: 784, at: 0, duration: 0.16, gain: 0.12 },
    { frequency: 1175, at: 0.11, duration: 0.24, gain: 0.12 }
  ]
};

const MIN_GAP_MS = 1200;

let context: AudioContext | null = null;
let lastPlayed = 0;

function getContext() {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  return context;
}

/** Browsers only allow audio after a user gesture; call once on mount to resume the context on the first interaction. */
export function primeSounds() {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => {
    void getContext()?.resume().catch(() => undefined);
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return unlock;
}

export function playSound(kind: SoundKind) {
  const ctx = getContext();
  if (!ctx || ctx.state !== "running") return;
  // Collapse bursts (e.g. several messages arriving at once) into a single sound.
  const now = Date.now();
  if (now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;

  const start = ctx.currentTime;
  for (const note of SOUNDS[kind]) {
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    const t = start + note.at;
    envelope.gain.setValueAtTime(0, t);
    envelope.gain.linearRampToValueAtTime(note.gain, t + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + note.duration);
    oscillator.connect(envelope).connect(ctx.destination);
    oscillator.start(t);
    oscillator.stop(t + note.duration + 0.02);
  }
}
