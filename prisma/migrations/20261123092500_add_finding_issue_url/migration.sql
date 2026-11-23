-- AlterTable
ALTER TABLE "Finding" ADD COLUMN "issueUrl" TEXT;

-- CreateIndex
CREATE INDEX "Finding_issueUrl_idx" ON "Finding"("issueUrl");
