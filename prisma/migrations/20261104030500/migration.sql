-- AlterEnum
ALTER TYPE "FindingTriageStatus" ADD VALUE IF NOT EXISTS 'DISMISSED';

-- CreateEnum
CREATE TYPE "DismissalReason" AS ENUM ('FALSE_POSITIVE', 'ACCEPTED_RISK', 'WONT_FIX');

-- AlterTable
ALTER TABLE "FindingTriage" ADD COLUMN "dismissalReason" "DismissalReason",
ADD COLUMN "dismissedAt" TIMESTAMP(3),
ADD COLUMN "dismissedById" TEXT;
