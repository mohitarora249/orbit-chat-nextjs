import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decodeCursor, encodeCursor, messageSelect, serializeMessage } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { getPrimaryWorkspaceLink } from "@/lib/workspace";
import { jsonError, routeError } from "@/lib/http";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@/lib/utils";
import type { SearchHit } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

type Row = { id: string; createdAt: Date; snippet: string };

// Full-text search over the generated "searchVector" column (GIN-indexed), newest first. The permission
// filter is inside the SQL so results never include conversations the user cannot open.
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
    if (!query) return NextResponse.json({ hits: [], nextCursor: null });
    if (query.length > 200) return jsonError("Search is limited to 200 characters.", 400);
    const rawCursor = request.nextUrl.searchParams.get("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) return jsonError("Invalid cursor.", 400);
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);

    // Passed as text so the comparison with the timezone-less column is exact.
    const cursorTime = (cursor?.createdAt ?? new Date(0)).toISOString().replace("Z", "");
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT m."id", m."createdAt",
        ts_headline('english', m."body", q, ${`StartSel=${HIGHLIGHT_START},StopSel=${HIGHLIGHT_END},MaxFragments=2,MaxWords=30,MinWords=10,FragmentDelimiter=" … "`}) AS snippet
      FROM "Message" m
      JOIN "Conversation" c ON c."id" = m."conversationId",
        websearch_to_tsquery('english', ${query}) q
      WHERE m."searchVector" @@ q
        AND m."deletedAt" IS NULL
        AND c."workspaceId" = ${workspaceLink.workspaceId}
        AND (
          (c."type" = 'CHANNEL' AND c."isPrivate" = false)
          OR EXISTS (SELECT 1 FROM "ConversationMember" cm WHERE cm."conversationId" = c."id" AND cm."userId" = ${user.id})
        )
        AND (${cursor === null} OR (m."createdAt", m."id") < (${cursorTime}::timestamp, ${cursor?.id ?? ""}))
      ORDER BY m."createdAt" DESC, m."id" DESC
      LIMIT ${PAGE_SIZE + 1}`;

    const page = rows.slice(0, PAGE_SIZE);
    const messages = await prisma.message.findMany({
      where: { id: { in: page.map(row => row.id) } },
      select: { ...messageSelect, conversation: { select: { id: true, name: true, type: true } } }
    });
    const byId = new Map(messages.map(message => [message.id, message]));
    const hits: SearchHit[] = page.flatMap(row => {
      const message = byId.get(row.id);
      if (!message) return [];
      const { conversation, ...rest } = message;
      return [{ message: serializeMessage(rest), conversation, snippet: row.snippet }];
    });
    return NextResponse.json({ hits, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null });
  } catch (error) {
    return routeError("GET /api/search", error, "Search failed.");
  }
}
