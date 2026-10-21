import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { serializeStatus, STATUS_TEXT_MAX, statusSelect } from "@/lib/presence";
import { parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const future = z.iso.datetime().refine(value => {
  const at = new Date(value).getTime() - Date.now();
  return at > 0 && at < MAX_AHEAD_MS;
}, "The time must be in the future and within a year.");

// Each part is optional: omit it to leave it alone, send null to clear it.
const statusSchema = z.object({
  custom: z.object({
    emoji: z.string().trim().min(1).max(16).nullable(),
    text: z.string().trim().max(STATUS_TEXT_MAX).transform(text => text || null).nullable(),
    expiresAt: future.nullable()
  }).refine(custom => custom.emoji || custom.text, "A status needs an emoji or some text.").nullable().optional(),
  dnd: z.object({ until: future.nullable() }).nullable().optional()
});

// Sets the signed-in user's custom status and/or Do Not Disturb, and tells their workspaces.
export async function PATCH(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { custom, dnd } = await parseJson(request, statusSchema);
    const data = {
      ...(custom !== undefined && {
        statusEmoji: custom?.emoji ?? null,
        statusText: custom?.text ?? null,
        statusExpiresAt: custom?.expiresAt ? new Date(custom.expiresAt) : null
      }),
      ...(dnd !== undefined && { dnd: dnd !== null, dndUntil: dnd?.until ? new Date(dnd.until) : null })
    };
    const updated = await prisma.$transaction(async tx => {
      const result = await tx.user.update({ where: { id: user.id }, data, select: statusSelect });
      await enqueue(tx, "user.status", { userId: user.id });
      return result;
    });
    notifyOutbox();
    return NextResponse.json({ status: serializeStatus(updated) });
  } catch (error) {
    return routeError("PATCH /api/status", error, "Could not update your status.");
  }
}
