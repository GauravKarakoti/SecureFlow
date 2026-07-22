-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "fingerprint" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "FindingTriage" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingTriage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FindingTriage_repositoryId_idx" ON "FindingTriage"("repositoryId");

-- CreateIndex
CREATE INDEX "FindingTriage_fingerprint_idx" ON "FindingTriage"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "FindingTriage_repositoryId_fingerprint_key" ON "FindingTriage"("repositoryId", "fingerprint");

-- CreateIndex
CREATE INDEX "Finding_fingerprint_idx" ON "Finding"("fingerprint");

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
