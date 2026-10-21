import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getConversationAccess } from "@/lib/access";
import { requireUser } from "@/lib/session";
import { presignDownload } from "@/lib/storage";
import { jsonError, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ attachmentId: string }> };

// Checks access on every request, then redirects to a presigned URL valid for one minute. Links copied out
// of the app therefore stop working quickly, and only scanned-clean files are ever served.
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { attachmentId } = await context.params;
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { message: { select: { deletedAt: true } } }
    });
    if (!attachment) return jsonError("Attachment not found.", 404);
    // Before it is sent, only the uploader may see it; afterwards anyone who can see the conversation.
    const visible = attachment.message
      ? !attachment.message.deletedAt && (await getConversationAccess(user.id, attachment.conversationId)) === "ok"
      : attachment.uploaderId === user.id;
    if (!visible) return jsonError("Attachment not found.", 404);
    if (attachment.status !== "CLEAN") {
      return jsonError(attachment.status === "INFECTED" ? "This file was blocked by the malware scanner." : "This file is not available yet.", 409);
    }

    const url = await presignDownload(attachment.storageKey, attachment.fileName, attachment.contentType);
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return routeError("GET attachment", error, "Could not open attachment.");
  }
}
