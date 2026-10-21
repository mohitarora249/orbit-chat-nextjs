import * as React from "react";
import { cn } from "@/lib/utils";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "outline";
  size?: "sm" | "md" | "icon";
};

export function Button({ className, variant = "primary", size = "md", ...props }: Props) {
  const variants = {
    primary: "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 shadow-sm",
    secondary: "bg-brand-50 text-brand-800 hover:bg-brand-100",
    ghost: "bg-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
    outline: "border border-zinc-200 bg-card text-zinc-700 hover:bg-zinc-50"
  };
  const sizes = { sm: "h-8 px-3 text-xs", md: "h-10 px-4 text-sm", icon: "h-9 w-9" };
  return <button className={cn("inline-flex items-center justify-center gap-2 rounded-lg font-medium transition duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40", variants[variant], sizes[size], className)} {...props} />;
}
