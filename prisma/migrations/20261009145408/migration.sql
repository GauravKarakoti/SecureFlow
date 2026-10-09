/*
  Warnings:

  - A unique constraint covering the columns `[repositoryId,prNumber]` on the table `PullRequest` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_pullRequestId_fkey";

-- CreateIndex
CREATE INDEX "AuditEventLedger_action_idx" ON "AuditEventLedger"("action");

-- CreateIndex
CREATE INDEX "AuditEventLedger_timestamp_idx" ON "AuditEventLedger"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "Finding_severity_idx" ON "Finding"("severity");

-- CreateIndex
CREATE INDEX "Finding_type_idx" ON "Finding"("type");

-- CreateIndex
CREATE INDEX "Finding_createdAt_idx" ON "Finding"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "FindingTriage_status_idx" ON "FindingTriage"("status");

-- CreateIndex
CREATE INDEX "FindingTriage_resolvedById_idx" ON "FindingTriage"("resolvedById");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_state_idx" ON "PullRequest"("repositoryId", "state");

-- CreateIndex
CREATE INDEX "PullRequest_createdAt_idx" ON "PullRequest"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repositoryId_prNumber_key" ON "PullRequest"("repositoryId", "prNumber");

-- CreateIndex
CREATE INDEX "Repository_userId_isActive_idx" ON "Repository"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Repository_fullName_idx" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "ScanJob_status_queuedAt_idx" ON "ScanJob"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "ScanJob_repositoryId_status_idx" ON "ScanJob"("repositoryId", "status");

-- CreateIndex
CREATE INDEX "ScanResult_policyDecision_idx" ON "ScanResult"("policyDecision");

-- CreateIndex
CREATE INDEX "ScanResult_createdAt_idx" ON "ScanResult"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_repositoryId_createdAt_idx" ON "WebhookEvent"("repositoryId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "remediation_patches_status_idx" ON "remediation_patches"("status");

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
