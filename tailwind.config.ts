import type { Config } from "tailwindcss";

const brandShades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: "hsl(var(--surface))",
        border: "hsl(var(--border))",
        brand: Object.fromEntries(brandShades.map(shade => [shade, `hsl(var(--brand-${shade}) / <alpha-value>)`]))
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"]
      },
      boxShadow: {
        // Shadows carry the neutral's hue rather than pure black.
        soft: "0 1px 2px rgba(24, 24, 32, 0.04), 0 12px 32px -8px rgba(24, 24, 40, 0.12)",
        float: "0 1px 2px rgba(24, 24, 32, 0.06), 0 4px 12px -2px rgba(24, 24, 40, 0.08)"
      },
      animation: {
        "fade-up": "fade-up 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "pop-in": "pop-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both"
      }
    }
  },
  plugins: []
};
export default config;
