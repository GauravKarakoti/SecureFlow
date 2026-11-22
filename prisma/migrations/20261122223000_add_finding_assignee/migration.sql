-- AlterTable
ALTER TABLE "FindingTriage" ADD COLUMN "assigneeId" TEXT;

-- CreateIndex
CREATE INDEX "FindingTriage_assigneeId_idx" ON "FindingTriage"("assigneeId");

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
