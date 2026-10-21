import { cn, initials } from "@/lib/utils";
import { presenceLabels, type Presence } from "@/lib/presence";

// The corner dot: filled green when active, a hollow ring when away, grey when offline. Do Not Disturb
// replaces it with a red "no entry" badge while the person is online.
export function Avatar({ name, color = "#4F6BD8", size = "md", presence, dnd }: { name: string; color?: string; size?: "sm" | "md" | "lg"; presence?: Presence; dnd?: boolean }) {
  const sizes = { sm: "h-6 w-6 rounded-md text-[11px]", md: "h-9 w-9 rounded-[10px] text-xs", lg: "h-11 w-11 rounded-xl text-sm" };
  const showDnd = dnd && presence !== undefined && presence !== "offline";
  return (
    <div aria-label={name} title={name} className={cn("relative flex shrink-0 items-center justify-center font-semibold text-white", sizes[size])} style={{ backgroundColor: color }}>
      <span className="opacity-95">{size === "sm" ? initials(name).slice(0, 1) : initials(name)}</span>
      {presence !== undefined && (showDnd ? (
        <span aria-label="Do not disturb" className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-rose-500 ring-2 ring-white">
          <span className="h-[1.5px] w-[5px] rounded-full bg-white"/>
        </span>
      ) : (
        <span aria-label={presenceLabels[presence]} className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white",
          presence === "active" ? "bg-emerald-500" : presence === "away" ? "bg-white shadow-[inset_0_0_0_1.5px_theme(colors.zinc.400)]" : "bg-zinc-300")}/>
      ))}
    </div>
  );
}
