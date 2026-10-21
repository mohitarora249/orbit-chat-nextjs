import type { Config } from "tailwindcss";

// Each palette reads from CSS variables in globals.css, which swap under .dark.
const ramp = (name: string, shades: readonly number[]) =>
  Object.fromEntries(shades.map(shade => [shade, `hsl(var(--${name}-${shade}) / <alpha-value>)`]));

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: "hsl(var(--surface))",
        card: "hsl(var(--card) / <alpha-value>)",
        border: "hsl(var(--border))",
        zinc: ramp("zinc", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        brand: ramp("brand", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        rose: ramp("rose", [50, 200, 500, 600, 700]),
        amber: ramp("amber", [50, 100, 200, 400, 500, 600, 700, 800, 900, 950])
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"]
      },
      boxShadow: {
        // Shadows carry the neutral's hue rather than pure black; dark mode deepens them.
        soft: "var(--shadow-soft)",
        float: "var(--shadow-float)"
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
