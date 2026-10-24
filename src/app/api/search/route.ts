import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decodeCursor, encodeCursor, messageSelect, serializeMessage } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { getPrimaryWorkspaceLink } from "@/lib/workspace";
import { visibleConversationsWhere } from "@/lib/access";
import { jsonError, routeError } from "@/lib/http";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@/lib/utils";
import { hasSearchFilters, parseSearch } from "@/lib/search";
import type { SearchHit } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START},StopSel=${HIGHLIGHT_END},MaxFragments=2,MaxWords=30,MinWords=10,FragmentDelimiter=" … "`;

type Row = { id: string; createdAt: Date; snippet: string | null };

function validTimeZone(timeZone: string | null) {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

// "today"/"yesterday" are the searcher's calendar days; other values must be real dates.
function resolveDate(value: string, timeZone: string) {
  if (value === "today" || value === "yesterday") {
    const now = new Date(Date.now() - (value === "yesterday" ? 86_400_000 : 0));
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : null;
}

// Full-text search over the generated "searchVector" column (GIN-indexed), newest first, narrowed by the
// filters in src/lib/search.ts. The permission filter is inside the SQL so results never include
// conversations the user cannot open.
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
    if (query.length > 200) return jsonError("Search is limited to 200 characters.", 400);
    const parsed = parseSearch(query);
    if (!parsed.tsquery && !hasSearchFilters(parsed)) return NextResponse.json({ hits: [], nextCursor: null, notes: [] });
    const rawCursor = request.nextUrl.searchParams.get("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) return jsonError("Invalid cursor.", 400);
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);
    const workspaceId = workspaceLink.workspaceId;
    const timeZone = validTimeZone(request.nextUrl.searchParams.get("tz"));

    // Anything that cannot be resolved is reported and makes the search match nothing, rather than being
    // silently dropped (which would widen the results).
    const notes = parsed.invalid.map(text => `“${text}” is not a filter this search understands.`);
    const conditions: Prisma.Sql[] = [];

    const handles = [...new Set([...parsed.from, ...parsed.inDms].filter(handle => handle !== "me"))];
    const people = handles.length ? await prisma.$queryRaw<{ id: string; handle: string; emailHandle: string }[]>`
      SELECT u."id", lower(regexp_replace(u."displayName", '[[:space:]]+', '', 'g')) AS handle, lower(split_part(u."email", '@', 1)) AS "emailHandle"
      FROM "User" u JOIN "WorkspaceMember" wm ON wm."userId" = u."id"
      WHERE wm."workspaceId" = ${workspaceId}
        AND (lower(regexp_replace(u."displayName", '[[:space:]]+', '', 'g')) = ANY(${handles}) OR lower(split_part(u."email", '@', 1)) = ANY(${handles}))` : [];
    const peopleFor = (handle: string) => handle === "me" ? [user.id] : people.filter(p => p.handle === handle || p.emailHandle === handle).map(p => p.id);

    if (parsed.inChannels.length || parsed.inDms.length) {
      const dmNames = parsed.inDms.flatMap(handle => {
        const ids = peopleFor(handle);
        if (!ids.length) notes.push(`Nobody in this workspace goes by @${handle}.`);
        return ids.map(id => [...new Set([user.id, id])].sort().join(":"));
      });
      const conversations = await prisma.conversation.findMany({
        where: {
          AND: [visibleConversationsWhere(user.id, workspaceId), {
            OR: [{ type: "CHANNEL", name: { in: parsed.inChannels } }, { type: "DM", name: { in: dmNames } }]
          }]
        },
        select: { id: true, type: true, name: true }
      });
      for (const name of parsed.inChannels) {
        if (!conversations.some(c => c.type === "CHANNEL" && c.name === name)) notes.push(`There is no channel #${name} you can see.`);
      }
      conditions.push(conversations.length ? Prisma.sql`m."conversationId" IN (${Prisma.join(conversations.map(c => c.id))})` : Prisma.sql`false`);
    }

    if (parsed.from.length) {
      const authorIds = parsed.from.flatMap(handle => {
        const ids = peopleFor(handle);
        if (!ids.length) notes.push(`Nobody in this workspace goes by @${handle}.`);
        return ids;
      });
      conditions.push(authorIds.length ? Prisma.sql`m."authorId" IN (${Prisma.join(authorIds)})` : Prisma.sql`false`);
    }

    for (const has of new Set(parsed.has)) {
      conditions.push(has === "file"
        ? Prisma.sql`EXISTS (SELECT 1 FROM "Attachment" a WHERE a."messageId" = m."id")`
        : Prisma.sql`EXISTS (SELECT 1 FROM "MessageLink" ml WHERE ml."messageId" = m."id")`);
    }

    // createdAt is UTC without a time zone; each date is the start of that day in the searcher's zone.
    const dayStart = (date: string, plusDays = 0) =>
      Prisma.sql`((${date}::date + ${plusDays}::int)::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC'`;
    for (const { key, value } of parsed.dates) {
      const date = resolveDate(value, timeZone);
      if (!date) { notes.push(`${key}:${value} is not a valid date (use YYYY-MM-DD).`); conditions.push(Prisma.sql`false`); continue; }
      if (key === "before") conditions.push(Prisma.sql`m."createdAt" < ${dayStart(date)}`);
      if (key === "after") conditions.push(Prisma.sql`m."createdAt" >= ${dayStart(date, 1)}`);
      if (key === "on") conditions.push(Prisma.sql`m."createdAt" >= ${dayStart(date)} AND m."createdAt" < ${dayStart(date, 1)}`);
    }

    if (parsed.invalid.length) conditions.push(Prisma.sql`false`);
    if (parsed.tsquery) conditions.push(Prisma.sql`m."searchVector" @@ to_tsquery('english', ${parsed.tsquery})`);

    // Passed as text so the comparison with the timezone-less column is exact.
    const cursorTime = (cursor?.createdAt ?? new Date(0)).toISOString().replace("Z", "");
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT m."id", m."createdAt",
        ${parsed.tsquery ? Prisma.sql`ts_headline('english', m."body", to_tsquery('english', ${parsed.tsquery}), ${HEADLINE_OPTIONS})` : Prisma.sql`NULL`} AS snippet
      FROM "Message" m
      JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE m."deletedAt" IS NULL
        AND c."workspaceId" = ${workspaceId}
        AND (
          (c."type" = 'CHANNEL' AND c."isPrivate" = false)
          OR EXISTS (SELECT 1 FROM "ConversationMember" cm WHERE cm."conversationId" = c."id" AND cm."userId" = ${user.id})
        )
        ${conditions.length ? Prisma.sql`AND ${Prisma.join(conditions, " AND ")}` : Prisma.empty}
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
      // Filter-only searches have nothing to highlight, so the snippet is the start of the message.
      return [{ message: serializeMessage(rest), conversation, snippet: row.snippet ?? rest.body }];
    });
    return NextResponse.json({ hits, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null, notes: [...new Set(notes)] });
  } catch (error) {
    return routeError("GET /api/search", error, "Search failed.");
  }
}
