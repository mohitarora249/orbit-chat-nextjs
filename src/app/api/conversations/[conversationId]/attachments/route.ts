import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { accessErrors, assertNotArchived, getConversationAccess } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { MAX_ATTACHMENT_BYTES, presignUpload, storageConfigured } from "@/lib/storage";
import { jsonError, parseJson, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_PENDING_UPLOADS = 20;

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255)
    // Keep only the base name and drop control characters; it is display text and a download filename.
    .transform(name => name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "file"),
  contentType: z.string().trim().max(127).regex(/^[\w.+-]+\/[\w.+-]+$/).catch("application/octet-stream"),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES, `Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
});

type Context = { params: Promise<{ conversationId: string }> };

// Step 1 of an upload: reserve an attachment and hand back a short-lived presigned PUT URL. The browser
// uploads straight to private storage; then it calls /api/attachments/:id/complete to start the scan.
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    if (!storageConfigured()) return jsonError("File uploads are not configured on this server.", 503);
    const { conversationId } = await context.params;
    const input = await parseJson(request, uploadSchema);
    const access = await getConversationAccess(user.id, conversationId);
    if (access !== "ok") return jsonError(accessErrors[access].error, accessErrors[access].status);
    await assertNotArchived(conversationId);

    const pending = await prisma.attachment.count({ where: { uploaderId: user.id, status: "PENDING_UPLOAD" } });
    if (pending >= MAX_PENDING_UPLOADS) return jsonError("Too many unfinished uploads. Try again shortly.", 429);

    const attachment = await prisma.attachment.create({
      data: {
        conversationId,
        uploaderId: user.id,
        storageKey: `conversations/${conversationId}/${randomUUID()}`,
        fileName: input.fileName,
        contentType: input.contentType,
        size: input.size
      },
      select: { id: true, fileName: true, contentType: true, size: true, status: true, storageKey: true }
    });
    const uploadUrl = await presignUpload(attachment.storageKey, attachment.contentType);
    const { storageKey: _key, ...publicAttachment } = attachment;
    return NextResponse.json({ attachment: publicAttachment, uploadUrl, uploadHeaders: { "Content-Type": attachment.contentType } }, { status: 201 });
  } catch (error) {
    return routeError("POST attachment", error, "Could not start upload.");
  }
}
