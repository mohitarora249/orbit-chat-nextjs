import { cn } from "@/lib/utils";

// A satellite on an orbit: the Orbit Chat mark. The satellite's dark outline cuts a gap in the ring.
// Same drawing as src/app/icon.svg (the favicon) and src/app/apple-icon.tsx.
export function Logo({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("flex h-7 w-7 shrink-0 rounded-lg bg-zinc-900", className)}>
      <svg viewBox="0 0 32 32" className="h-full w-full">
        <circle cx="16" cy="16" r="7.5" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="2.25"/>
        <circle cx="21.3" cy="10.7" r="3.25" className="fill-brand-400 stroke-zinc-900" strokeWidth="1.75"/>
      </svg>
    </span>
  );
}
