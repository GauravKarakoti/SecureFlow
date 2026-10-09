-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "Finding_scanResultId_idx" ON "Finding"("scanResultId");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_idx" ON "PullRequest"("repositoryId");

-- CreateIndex
CREATE INDEX "Repository_userId_idx" ON "Repository"("userId");

-- CreateIndex
CREATE INDEX "ScanResult_pullRequestId_idx" ON "ScanResult"("pullRequestId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "UserPolicyToggle_userId_idx" ON "UserPolicyToggle"("userId");

-- CreateIndex
CREATE INDEX "UserPolicyToggle_policyTemplateId_idx" ON "UserPolicyToggle"("policyTemplateId");
