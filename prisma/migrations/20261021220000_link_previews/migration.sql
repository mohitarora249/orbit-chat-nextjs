-- CreateEnum
CREATE TYPE "LinkPreviewStatus" AS ENUM ('PENDING', 'OK', 'FAILED');

-- CreateTable
CREATE TABLE "LinkPreview" (
    "url" TEXT NOT NULL,
    "status" "LinkPreviewStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "description" TEXT,
    "siteName" TEXT,
    "imageUrl" TEXT,
    "fetchedAt" TIMESTAMP(3),

    CONSTRAINT "LinkPreview_pkey" PRIMARY KEY ("url")
);

-- CreateTable
CREATE TABLE "MessageLink" (
    "messageId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "MessageLink_pkey" PRIMARY KEY ("messageId","position")
);

-- CreateIndex
CREATE INDEX "MessageLink_url_idx" ON "MessageLink"("url");

-- AddForeignKey
ALTER TABLE "MessageLink" ADD CONSTRAINT "MessageLink_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageLink" ADD CONSTRAINT "MessageLink_url_fkey" FOREIGN KEY ("url") REFERENCES "LinkPreview"("url") ON DELETE CASCADE ON UPDATE CASCADE;

