-- Keep the scanned commit and gate policy with each result. Triage can only
-- revise a GitHub check when the result belongs to the PR's current head.
ALTER TABLE "ScanResult"
ADD COLUMN "headSha" TEXT,
ADD COLUMN "gateConfig" JSONB;
