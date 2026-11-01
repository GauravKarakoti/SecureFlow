-- AlterTable
ALTER TABLE "FindingTriage" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "FindingTriage_expiresAt_idx" ON "FindingTriage"("expiresAt");

