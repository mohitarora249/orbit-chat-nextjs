-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dndUntil" TIMESTAMP(3),
ADD COLUMN     "statusEmoji" TEXT,
ADD COLUMN     "statusExpiresAt" TIMESTAMP(3),
ADD COLUMN     "statusText" TEXT;
