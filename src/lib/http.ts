import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { HttpError } from "./errors";

export { HttpError };

export function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const raw = await request.json().catch(() => {
    throw new HttpError(400, "Request body must be JSON.");
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}

export function routeError(label: string, error: unknown, fallback: string) {
  if (error instanceof HttpError) return jsonError(error.message, error.status);
  console.error(`${label} failed`, error);
  return jsonError(fallback, 500);
}
