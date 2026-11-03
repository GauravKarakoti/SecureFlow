-- Analytics filters dates within the authenticated user's scans. A plain
-- scanResultId index must read and discard every older finding in each scan.
CREATE INDEX "Finding_scanResultId_createdAt_idx"
ON "Finding"("scanResultId", "createdAt" DESC);

-- Severity bucket pagination filters the same scan/severity prefix as before,
-- but can now read newest findings without sorting the whole bucket.
CREATE INDEX "Finding_scanResultId_severity_createdAt_idx"
ON "Finding"("scanResultId", "severity", "createdAt" DESC);

-- The new index retains this index's complete leftmost prefix.
DROP INDEX "Finding_scanResultId_severity_idx";
