-- CreateTable
CREATE TABLE "remediation_patches" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "patchDiff" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remediation_patches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "remediation_patches_findingId_key" ON "remediation_patches"("findingId");

-- CreateIndex
CREATE INDEX "Finding_scanResultId_severity_idx" ON "Finding"("scanResultId", "severity");

-- CreateIndex
CREATE INDEX "FindingTriage_repositoryId_status_idx" ON "FindingTriage"("repositoryId", "status");

-- AddForeignKey
ALTER TABLE "remediation_patches" ADD CONSTRAINT "remediation_patches_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
