-- CreateIndex
CREATE INDEX "AuditLog_userId_timestamp_idx" ON "AuditLog"("userId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "ScanResult_pullRequestId_createdAt_idx" ON "ScanResult"("pullRequestId", "createdAt" DESC);
