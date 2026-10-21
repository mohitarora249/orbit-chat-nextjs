"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ACCENTS, DEFAULT_PREFS, STORAGE_KEY, type ThemePrefs } from "@/lib/theme-script";

export { ACCENTS, type Accent, type ThemeMode, type ThemePrefs } from "@/lib/theme-script";

declare global { interface Window { __applyTheme?: () => void } }

function readPrefs(): ThemePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<ThemePrefs>;
    return {
      mode: raw.mode === "light" || raw.mode === "dark" ? raw.mode : "system",
      accent: ACCENTS.some(accent => accent.id === raw.accent) ? raw.accent! : "indigo"
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

// The <head> script owns applying the theme (and following the OS); this only tells it to re-read.
let snapshot: ThemePrefs | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { snapshot = readPrefs(); listener(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

export function useTheme() {
  const prefs = useSyncExternalStore(subscribe, () => (snapshot ??= readPrefs()), () => DEFAULT_PREFS);
  const setPrefs = useCallback((patch: Partial<ThemePrefs>) => {
    snapshot = { ...(snapshot ?? readPrefs()), ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* storage unavailable */ }
    window.__applyTheme?.();
    listeners.forEach(listener => listener());
  }, []);
  return { ...prefs, setPrefs };
}
