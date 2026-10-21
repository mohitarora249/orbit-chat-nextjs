import { cn, initials } from "@/lib/utils";

export function Avatar({ name, color = "#4F6BD8", size = "md", online }: { name: string; color?: string; size?: "sm" | "md" | "lg"; online?: boolean }) {
  const sizes = { sm: "h-6 w-6 rounded-md text-[11px]", md: "h-9 w-9 rounded-[10px] text-xs", lg: "h-11 w-11 rounded-xl text-sm" };
  return (
    <div aria-label={name} title={name} className={cn("relative flex shrink-0 items-center justify-center font-semibold text-white", sizes[size])} style={{ backgroundColor: color }}>
      <span className="opacity-95">{size === "sm" ? initials(name).slice(0, 1) : initials(name)}</span>
      {online !== undefined && (
        <span aria-label={online ? "Online" : "Offline"} className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white", online ? "bg-emerald-500" : "bg-zinc-300")}/>
      )}
    </div>
  );
}
