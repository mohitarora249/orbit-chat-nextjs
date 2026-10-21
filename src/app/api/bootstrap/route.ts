import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getPrimaryWorkspaceLink } from "@/lib/workspace";
import { listConversations, listPinnedConversationIds } from "@/lib/conversations";
import { jsonError, routeError } from "@/lib/http";
import { serializeStatus, statusSelect } from "@/lib/presence";
import type { Bootstrap } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireUser(request);
    if (error) return error;
    const workspaceLink = await getPrimaryWorkspaceLink(user.id);
    if (!workspaceLink) return jsonError("You are not a member of any workspace.", 403);
    const [members, conversations, pinnedConversationIds] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId: workspaceLink.workspaceId },
        orderBy: [{ user: { displayName: "asc" } }, { userId: "asc" }],
        select: { user: { select: { id: true, displayName: true, avatarColor: true, ...statusSelect } } }
      }),
      listConversations(user.id, workspaceLink.workspaceId),
      listPinnedConversationIds(user.id, workspaceLink.workspaceId)
    ]);
    const body: Bootstrap = {
      me: { id: user.id, displayName: user.displayName, avatarColor: user.avatarColor, email: user.email },
      users: members.map(({ user: { id, displayName, avatarColor } }) => ({ id, displayName, avatarColor })),
      statuses: Object.fromEntries(members.flatMap(({ user }) => {
        const status = serializeStatus(user);
        return status ? [[user.id, status]] : [];
      })),
      workspace: { id: workspaceLink.workspace.id, name: workspaceLink.workspace.name, slug: workspaceLink.workspace.slug, role: workspaceLink.role },
      conversations,
      pinnedConversationIds
    };
    return NextResponse.json(body);
  } catch (error) {
    return routeError("GET /api/bootstrap", error, "Failed to load workspace.");
  }
}
