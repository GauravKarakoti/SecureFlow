-- Optimize Prisma Indexing for Leaderboard Queries (#403)
--
-- Adds compound indexes to support heavy read operations, sorting, and user score aggregation
-- on the public leaderboard and real-time SSE streams.

-- 1. Compound index on PullRequest(authorLogin, state) for merged PR count aggregations
CREATE INDEX "PullRequest_authorLogin_state_idx" ON "PullRequest"("authorLogin", "state");

-- 2. Compound index on PullRequest(authorLogin, status) for passed PR count aggregations
CREATE INDEX "PullRequest_authorLogin_status_idx" ON "PullRequest"("authorLogin", "status");

-- 3. Compound index on PullRequest(authorLogin, authorAvatarUrl) for contributor avatar lookups
CREATE INDEX "PullRequest_authorLogin_authorAvatarUrl_idx" ON "PullRequest"("authorLogin", "authorAvatarUrl");

-- 4. Compound index on PullRequest(authorLogin, createdAt DESC) for author form history scans
CREATE INDEX "PullRequest_authorLogin_createdAt_idx" ON "PullRequest"("authorLogin", "createdAt" DESC);

-- 5. Compound index on Finding(scanResultId, fingerprint) for finding severity lookups per scan
CREATE INDEX "Finding_scanResultId_fingerprint_idx" ON "Finding"("scanResultId", "fingerprint");

-- 6. Compound index on FindingTriage(status, fingerprint) for suppressed finding lookups
CREATE INDEX "FindingTriage_status_fingerprint_idx" ON "FindingTriage"("status", "fingerprint");

-- 7. Compound index on User(codename, githubLogin) for leaderboard alias resolutions
CREATE INDEX "User_codename_githubLogin_idx" ON "User"("codename", "githubLogin");
