-- AlterTable
ALTER TABLE "FindingTriage" ADD COLUMN     "assigneeId" TEXT;

-- CreateTable
CREATE TABLE "FindingNote" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FindingNote_findingId_createdAt_idx" ON "FindingNote"("findingId", "createdAt");

-- CreateIndex
CREATE INDEX "FindingNote_authorId_idx" ON "FindingNote"("authorId");

-- CreateIndex
CREATE INDEX "FindingTriage_assigneeId_idx" ON "FindingTriage"("assigneeId");

-- AddForeignKey
ALTER TABLE "FindingNote" ADD CONSTRAINT "FindingNote_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingNote" ADD CONSTRAINT "FindingNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
