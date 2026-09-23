-- CreateIndex
CREATE INDEX "Finding_scanResultId_type_idx" ON "Finding"("scanResultId", "type");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_status_idx" ON "PullRequest"("repositoryId", "status");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_createdAt_idx" ON "PullRequest"("repositoryId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ScanResult_pullRequestId_policyDecision_idx" ON "ScanResult"("pullRequestId", "policyDecision");
