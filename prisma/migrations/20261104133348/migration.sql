-- CreateEnum
CREATE TYPE "DismissalReason" AS ENUM ('FALSE_POSITIVE', 'ACCEPTED_RISK', 'WONT_FIX');

-- AlterEnum
ALTER TYPE "FindingTriageStatus" ADD VALUE 'DISMISSED';

-- DropIndex
DROP INDEX "Finding_scanResultId_severity_idx";

-- AlterTable
ALTER TABLE "FindingTriage" ADD COLUMN     "dismissalReason" "DismissalReason",
ADD COLUMN     "dismissedAt" TIMESTAMP(3),
ADD COLUMN     "dismissedById" TEXT;

-- CreateIndex
CREATE INDEX "Finding_scanResultId_createdAt_idx" ON "Finding"("scanResultId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Finding_scanResultId_severity_createdAt_idx" ON "Finding"("scanResultId", "severity", "createdAt" DESC);
