import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";

export type SessionUser = { id: string; displayName: string; avatarColor: string; email: string };

type Authed = { user: SessionUser; error?: undefined } | { user?: undefined; error: NextResponse };

// Every route handler derives identity from the Better Auth session cookie, never from the request body.
// State-changing requests must also come from our own origin (defence in depth on top of SameSite cookies).
export async function requireUser(request: NextRequest): Promise<Authed> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin && origin !== request.nextUrl.origin && origin !== process.env.NEXT_PUBLIC_APP_URL) {
      return { error: NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 }) };
    }
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };
  const { id, name, email } = session.user;
  return { user: { id, displayName: name, email, avatarColor: String(session.user.avatarColor ?? "#635BFF") } };
}
