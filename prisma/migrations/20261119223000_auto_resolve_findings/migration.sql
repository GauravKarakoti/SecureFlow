-- AlterTable
ALTER TABLE "FindingTriage" ADD COLUMN "resolvedAt" TIMESTAMP(3),
ADD COLUMN "resolvedCommitSha" TEXT;
