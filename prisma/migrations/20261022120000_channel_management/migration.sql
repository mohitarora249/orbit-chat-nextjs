-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "description" TEXT,
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Public channel membership now decides whose sidebar shows a channel. Until now every public channel was
-- shown to everyone in its workspace, so make everyone a member to keep their sidebars as they were.
INSERT INTO "ConversationMember" ("id", "conversationId", "userId", "joinedAt")
SELECT 'cm_' || md5(c."id" || ':' || wm."userId"), c."id", wm."userId", now()
FROM "Conversation" c
JOIN "WorkspaceMember" wm ON wm."workspaceId" = c."workspaceId"
WHERE c."type" = 'CHANNEL' AND c."isPrivate" = false
ON CONFLICT ("conversationId", "userId") DO NOTHING;
