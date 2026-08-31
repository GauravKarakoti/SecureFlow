-- Compound indexes for finding triage queries (#731).
--
-- As the findings data grows, the /dashboard/findings triage view filters by
-- repository, severity and triage status. The existing single-column indexes
-- do not cover these combined predicates, so each query scanned a wider set of
-- rows and then filtered.
--
-- planSeverityPage walks one severity bucket at a time within a scan's
-- findings, so the list and its per-bucket counts filter on
-- (scanResultId, severity) together.
CREATE INDEX "Finding_scanResultId_severity_idx" ON "Finding"("scanResultId", "severity");

-- getSuppressedFingerprints filters a repository's triage rows by status; the
-- plain (repositoryId) index still had to scan and filter status, so pair them.
CREATE INDEX "FindingTriage_repositoryId_status_idx" ON "FindingTriage"("repositoryId", "status");
