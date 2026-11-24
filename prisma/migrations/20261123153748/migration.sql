-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FINDING_ASSIGNED', 'MENTION', 'DISMISSAL_EXPIRING');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyOnAssignment" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyOnDismissalExpiry" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyOnMention" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "findingId" TEXT,
    "scanId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
