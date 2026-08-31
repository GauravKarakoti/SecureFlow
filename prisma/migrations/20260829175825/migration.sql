-- CreateEnum
CREATE TYPE "ScanJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ScanJob" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT,
    "pullRequestId" TEXT,
    "status" "ScanJobStatus" NOT NULL DEFAULT 'PENDING',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "scannedFiles" INTEGER NOT NULL DEFAULT 0,
    "vulnerabilitiesFound" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER,
    "policyDecision" "PolicyDecision",
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScanJob_status_idx" ON "ScanJob"("status");

-- CreateIndex
CREATE INDEX "ScanJob_repositoryId_idx" ON "ScanJob"("repositoryId");

-- CreateIndex
CREATE INDEX "ScanJob_pullRequestId_idx" ON "ScanJob"("pullRequestId");

-- CreateIndex
CREATE INDEX "ScanJob_createdAt_idx" ON "ScanJob"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
