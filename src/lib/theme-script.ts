// Appearance is a per-browser preference: a mode (light, dark, or follow the OS) and an accent hue.
// The <head> script below applies it before first paint; the hook keeps it in sync afterwards.
export type ThemeMode = "light" | "dark" | "system";
export type Accent = "indigo" | "violet" | "teal" | "green" | "rose" | "orange";
export type ThemePrefs = { mode: ThemeMode; accent: Accent };

export const ACCENTS: { id: Accent; label: string; hue: number }[] = [
  { id: "indigo", label: "Indigo", hue: 226 },
  { id: "violet", label: "Violet", hue: 262 },
  { id: "teal", label: "Teal", hue: 182 },
  { id: "green", label: "Green", hue: 150 },
  { id: "rose", label: "Rose", hue: 346 },
  { id: "orange", label: "Orange", hue: 22 }
];

export const STORAGE_KEY = "orbit-chat-theme";
export const DEFAULT_PREFS: ThemePrefs = { mode: "system", accent: "indigo" };
// Keep in sync with --background in globals.css; the mobile browser chrome follows it.
export const THEME_COLORS = { light: "#fcfcfd", dark: "#131316" };

// Runs inline in <head>, so it must be self-contained: applies the stored preference before first paint
// and re-applies it when the OS switches light/dark or another tab changes it. Mirrors applyTheme in theme.ts.
export const themeScript = `(function () {
  var key = ${JSON.stringify(STORAGE_KEY)}, hues = ${JSON.stringify(Object.fromEntries(ACCENTS.map(accent => [accent.id, accent.hue])))};
  var colors = ${JSON.stringify(THEME_COLORS)}, query = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    var prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) {}
    var mode = prefs.mode === "light" || prefs.mode === "dark" ? prefs.mode : query.matches ? "dark" : "light";
    var root = document.documentElement;
    root.classList.toggle("dark", mode === "dark");
    root.style.colorScheme = mode;
    if (hues[prefs.accent]) root.style.setProperty("--brand-h", String(hues[prefs.accent]));
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) { meta.setAttribute("content", colors[mode]); meta.removeAttribute("media"); });
  }
  apply();
  query.addEventListener("change", apply);
  window.addEventListener("storage", function (event) { if (event.key === key) apply(); });
  document.addEventListener("DOMContentLoaded", apply);
  window.__applyTheme = apply;
})();`;
