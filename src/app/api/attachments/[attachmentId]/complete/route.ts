import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { MAX_ATTACHMENT_BYTES, deleteObject, objectSize } from "@/lib/storage";
import { enqueue, notifyOutbox } from "@/lib/outbox";
import { jsonError, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ attachmentId: string }> };

const publicSelect = { id: true, fileName: true, contentType: true, size: true, status: true } as const;

// Step 2 of an upload: confirm the object really exists with the declared size, then queue the malware scan.
// The file stays undownloadable until the scan marks it CLEAN.
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { attachmentId } = await context.params;
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.uploaderId !== user.id) return jsonError("Attachment not found.", 404);
    if (attachment.status !== "PENDING_UPLOAD") {
      return NextResponse.json({ attachment: await prisma.attachment.findUnique({ where: { id: attachmentId }, select: publicSelect }) });
    }

    const size = await objectSize(attachment.storageKey);
    if (size === null) return jsonError("Upload not found in storage. Upload the file before completing it.", 400);
    if (size !== attachment.size || size > MAX_ATTACHMENT_BYTES) {
      await deleteObject(attachment.storageKey).catch(() => undefined);
      await prisma.attachment.update({ where: { id: attachmentId }, data: { status: "FAILED" } });
      return jsonError("The uploaded file does not match what was declared.", 400);
    }

    const updated = await prisma.$transaction(async tx => {
      const result = await tx.attachment.update({ where: { id: attachmentId }, data: { status: "SCANNING" }, select: publicSelect });
      await enqueue(tx, "attachment.scan", { attachmentId });
      return result;
    });
    notifyOutbox();
    return NextResponse.json({ attachment: updated });
  } catch (error) {
    return routeError("POST attachment complete", error, "Could not finish upload.");
  }
}
