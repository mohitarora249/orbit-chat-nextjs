"use client";

import { ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// Closes on Escape or a pointer press outside `ref`.
export function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [ref, onClose, active]);
}

export function Dialog({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useDismiss(panelRef, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/20 p-4 pt-[12vh] backdrop-blur-[2px]">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className={cn("w-full max-w-md overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-soft animate-pop-in", className)}>
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"><X size={16}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// A small floating panel anchored to its positioned parent.
export function Popover({ onClose, children, className }: { onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, onClose);
  return <div ref={ref} className={cn("absolute z-40 animate-pop-in rounded-xl border border-zinc-200/80 bg-white shadow-soft", className)}>{children}</div>;
}
