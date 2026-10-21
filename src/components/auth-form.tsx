"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { authClient } from "@/lib/auth-client";

type Mode = "signin" | "signup";

const inputClass = "mt-1.5 block h-10 w-full rounded-lg border border-zinc-200 bg-card px-3 text-sm font-normal outline-none transition placeholder:text-zinc-400 focus:border-brand-300 focus:ring-4 focus:ring-brand-100/60";

export function AuthForm({ initialMode, showDemoHint }: { initialMode: Mode; showDemoHint: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const result = mode === "signin"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ name: name.trim(), email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong. Try again.");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface p-4">
      <div className="w-full max-w-[360px] animate-fade-up">
        <Logo className="h-10 w-10 rounded-xl"/>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">{mode === "signin" ? "Sign in to Orbit Chat" : "Create your account"}</h1>
        <p className="mt-1.5 text-sm text-zinc-500">{mode === "signin" ? "Welcome back. Pick up where your team left off." : "You'll join your team's workspace."}</p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          {mode === "signup" && (
            <label className="block text-[13px] font-medium text-zinc-700">Full name
              <input required value={name} onChange={event => setName(event.target.value)} autoComplete="name" maxLength={80} className={inputClass}/>
            </label>
          )}
          <label className="block text-[13px] font-medium text-zinc-700">Email
            <input required type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" className={inputClass}/>
          </label>
          <label className="block text-[13px] font-medium text-zinc-700">Password
            <input required type="password" minLength={8} value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} className={inputClass}/>
          </label>
          {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{error}</p>}
          <Button type="submit" disabled={pending} className="mt-2 w-full">{pending ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</Button>
        </form>
        <p className="mt-6 text-[13px] text-zinc-500">
          {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
          <button type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }} className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-4 transition hover:decoration-zinc-900">
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
        {showDemoHint && mode === "signin" && (
          <p className="mt-8 rounded-lg border border-zinc-200 bg-card px-3.5 py-3 text-xs leading-5 text-zinc-500">
            Local demo: sign in as <b>mohit@example.com</b>, <b>aisha@example.com</b> or <b>rohan@example.com</b> with password <b>orbit-demo-123</b> (after <code>npm run db:seed</code>).
          </p>
        )}
      </div>
    </main>
  );
}
