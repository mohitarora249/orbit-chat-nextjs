import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect("/");
  const { mode } = await searchParams;
  return <AuthForm initialMode={mode === "signup" ? "signup" : "signin"} showDemoHint={process.env.NODE_ENV !== "production"} />;
}
