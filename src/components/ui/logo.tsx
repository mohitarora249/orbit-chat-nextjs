import { cn } from "@/lib/utils";

// A dot on an orbit: the Orbit Chat mark, drawn in CSS so it needs no asset.
export function Logo({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900", className)}>
      <span className="h-3.5 w-3.5 rounded-full border-[1.5px] border-white/80"/>
      <span className="absolute right-[7px] top-[7px] h-1.5 w-1.5 rounded-full bg-brand-400"/>
    </span>
  );
}
