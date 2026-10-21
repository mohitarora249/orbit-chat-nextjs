import { prisma } from "./prisma";

const DEFAULT_WORKSPACE_SLUG = process.env.DEFAULT_WORKSPACE_SLUG || "acme";

// New sign-ups join the default workspace and its #general channel; other public channels they find with
// "Browse channels". If there is no workspace yet, the first person to sign up creates it (with a #general
// channel) and becomes its owner.
export async function provisionNewUser(userId: string) {
  await prisma.$transaction(async tx => {
    const existing = await tx.workspace.findUnique({ where: { slug: DEFAULT_WORKSPACE_SLUG } });
    if (existing) {
      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: existing.id, userId } },
        update: {},
        create: { workspaceId: existing.id, userId, role: "MEMBER" }
      });
      const general = await tx.conversation.findUnique({
        where: { workspaceId_type_name: { workspaceId: existing.id, type: "CHANNEL", name: "general" } },
        select: { id: true, isPrivate: true, archivedAt: true }
      });
      if (general && !general.isPrivate && !general.archivedAt) {
        await tx.conversationMember.createMany({ data: [{ conversationId: general.id, userId }], skipDuplicates: true });
      }
      return;
    }
    const workspace = await tx.workspace.create({ data: { name: "Orbit", slug: DEFAULT_WORKSPACE_SLUG } });
    await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role: "OWNER" } });
    await tx.conversation.create({
      data: { workspaceId: workspace.id, name: "general", type: "CHANNEL", createdById: userId, members: { create: { userId } } }
    });
  });
}

// The app currently shows one workspace per user: the first one they joined.
export function getPrimaryWorkspaceLink(userId: string) {
  return prisma.workspaceMember.findFirst({
    where: { userId },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    include: { workspace: true }
  });
}
