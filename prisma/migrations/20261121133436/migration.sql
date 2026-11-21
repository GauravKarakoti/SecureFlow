-- CreateTable
CREATE TABLE "stored_scan_inputs" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestId" TEXT,
    "headSha" TEXT,
    "filesJson" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_scan_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stored_scan_inputs_repositoryId_createdAt_idx" ON "stored_scan_inputs"("repositoryId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "stored_scan_inputs_createdAt_idx" ON "stored_scan_inputs"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "stored_scan_inputs" ADD CONSTRAINT "stored_scan_inputs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_scan_inputs" ADD CONSTRAINT "stored_scan_inputs_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
