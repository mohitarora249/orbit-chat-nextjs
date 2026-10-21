import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMessageAccess } from "@/lib/access";
import { cursorWhere, decodeCursor, encodeCursor, messageSelect, parseLimit, serializeMessage } from "@/lib/messages";
import { withMyVotes } from "@/lib/polls";
import { requireUser } from "@/lib/session";
import { jsonError, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

type Context = { params: Promise<{ messageId: string }> };

// A thread: the parent plus its replies oldest-first. `cursor` (the previous page's nextCursor) continues
// with newer replies.
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const { messageId } = await context.params;
    const message = await requireMessageAccess(user.id, messageId);
    if (message.parentId) return jsonError("That message is a reply, not a thread.", 400);

    const searchParams = request.nextUrl.searchParams;
    const limit = parseLimit(searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    if (limit === null) return jsonError("limit must be an integer.", 400);
    const rawCursor = searchParams.get("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) return jsonError("Invalid cursor.", 400);

    const [parent, page] = await Promise.all([
      prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: messageSelect }),
      prisma.message.findMany({
        where: { parentId: messageId, deletedAt: null, ...(cursor ? cursorWhere(cursor, "after") : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: messageSelect
      })
    ]);
    const items = page.slice(0, limit);
    const [withVotes, ...messages] = await withMyVotes(user.id, [parent, ...items].map(serializeMessage));
    return NextResponse.json({
      parent: withVotes,
      messages,
      nextCursor: page.length > limit ? encodeCursor(items[items.length - 1]) : null
    });
  } catch (error) {
    return routeError("GET replies", error, "Could not load thread.");
  }
}
