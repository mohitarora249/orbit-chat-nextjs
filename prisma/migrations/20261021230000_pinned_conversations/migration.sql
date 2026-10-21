-- CreateTable
CREATE TABLE "PinnedConversation" (
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinnedConversation_pkey" PRIMARY KEY ("userId","conversationId")
);

-- CreateIndex
CREATE INDEX "PinnedConversation_conversationId_idx" ON "PinnedConversation"("conversationId");

-- AddForeignKey
ALTER TABLE "PinnedConversation" ADD CONSTRAINT "PinnedConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinnedConversation" ADD CONSTRAINT "PinnedConversation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

