-- AlterTable
ALTER TABLE "Message" ADD COLUMN "forwardedFromId" TEXT;

-- CreateIndex
CREATE INDEX "Message_forwardedFromId_idx" ON "Message"("forwardedFromId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_forwardedFromId_fkey" FOREIGN KEY ("forwardedFromId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
