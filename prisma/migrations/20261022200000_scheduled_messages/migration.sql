-- DropIndex
DROP INDEX "Reminder_firedAt_remindAt_idx";

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "messageId" TEXT;

-- CreateTable
CREATE TABLE "ScheduledMessage" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "failedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledMessage_authorId_sendAt_idx" ON "ScheduledMessage"("authorId", "sendAt");

-- CreateIndex
CREATE INDEX "ScheduledMessage_conversationId_idx" ON "ScheduledMessage"("conversationId");

-- CreateIndex
CREATE INDEX "ScheduledMessage_parentId_idx" ON "ScheduledMessage"("parentId");

-- CreateIndex
CREATE INDEX "Reminder_messageId_idx" ON "Reminder"("messageId");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMessage" ADD CONSTRAINT "ScheduledMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMessage" ADD CONSTRAINT "ScheduledMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledMessage" ADD CONSTRAINT "ScheduledMessage_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reminders are now fired by the outbox worker instead of a clock: queue a `reminder.due` event for every
-- reminder still waiting. It becomes available at the reminder's time (or straight away if that has passed).
INSERT INTO "OutboxEvent" ("type", "payload", "availableAt")
SELECT 'reminder.due', jsonb_build_object('reminderId', "id"), "remindAt"
FROM "Reminder"
WHERE "firedAt" IS NULL;
