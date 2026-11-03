-- Run only in a disposable PostgreSQL database initialized from main's schema.
-- Seed, candidate indexes, and helper objects are rolled back at the end.
\set ON_ERROR_STOP on
\timing on
BEGIN;

INSERT INTO "User" (id, "updatedAt")
SELECT 'bench-1515-user-' || i, now() FROM generate_series(1, 50) i;
INSERT INTO "Repository" (id, "githubId", "fullName", owner, "userId")
SELECT 'bench-1515-repo-' || i, 9000000000 + i, 'benchmark/repo-' || i,
       'benchmark', 'bench-1515-user-' || i FROM generate_series(1, 50) i;
INSERT INTO "PullRequest" (id, "githubId", "prNumber", title, "repositoryId")
SELECT 'bench-1515-pr-' || i, 9000000000 + i, (i - 1) % 10 + 1,
       'Synthetic benchmark PR', 'bench-1515-repo-' || ((i - 1) / 10 + 1)
FROM generate_series(1, 500) i;
INSERT INTO "ScanResult" (id, "pullRequestId", "riskScore")
SELECT 'bench-1515-scan-' || i, 'bench-1515-pr-' || i, 42
FROM generate_series(1, 500) i;
INSERT INTO "Finding" (id, "scanResultId", type, severity, "fileLocation", "codeSnippet", "createdAt")
SELECT 'bench-1515-finding-' || i,
       'bench-1515-scan-' || ((i - 1) / 1000 + 1),
       'VULNERABILITY'::"FindingType",
       (ARRAY['CRITICAL','HIGH','MEDIUM','LOW','INFO'])[i % 5 + 1]::"FindingSeverity",
       'src/synthetic-' || i || '.ts', repeat('synthetic benchmark text ', 8),
       timestamp '2025-01-01' + (i % 365) * interval '1 day' + (i % 1000) * interval '1 second'
FROM generate_series(1, 500000) i;
ANALYZE "User", "Repository", "PullRequest", "ScanResult", "Finding";

CREATE TEMP TABLE benchmark_queries (name text, sql text);
INSERT INTO benchmark_queries VALUES
('analytics_window', $q$
 SELECT f.id, f.severity, f."createdAt" FROM "Finding" f
 WHERE f."createdAt" >= timestamp '2025-12-25'
 AND f."createdAt" < timestamp '2026-01-01'
 AND EXISTS (
   SELECT 1 FROM "ScanResult" s
   JOIN "PullRequest" p ON p.id = s."pullRequestId"
   JOIN "Repository" r ON r.id = p."repositoryId"
   WHERE s.id = f."scanResultId" AND r."userId" = 'bench-1515-user-1'
 ) ORDER BY f."createdAt" ASC
$q$),
('scan_severity_page', $q$
 SELECT id, severity, "createdAt" FROM "Finding"
 WHERE "scanResultId" = 'bench-1515-scan-1' AND severity = 'CRITICAL'
 ORDER BY "createdAt" DESC LIMIT 20
$q$),
('scan_newest_page', $q$
 SELECT id, severity, "createdAt" FROM "Finding"
 WHERE "scanResultId" = 'bench-1515-scan-1'
 ORDER BY "createdAt" DESC LIMIT 20
$q$);

CREATE TEMP TABLE benchmark_results (phase text, name text, run integer, plan jsonb);
CREATE TEMP TABLE benchmark_fingerprints (phase text, name text, fingerprint text);
CREATE FUNCTION pg_temp.measure(phase text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q record; plan jsonb; iteration integer; fingerprint text;
BEGIN
 FOR q IN SELECT * FROM benchmark_queries LOOP
   EXECUTE 'SELECT md5(string_agg(id, '','' ORDER BY id)) FROM (' || q.sql || ') result'
     INTO fingerprint;
   INSERT INTO benchmark_fingerprints VALUES (phase, q.name, fingerprint);
   -- One warmup, then five measured executions. Keep the planner defaults.
   FOR iteration IN 0..5 LOOP
     EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || q.sql INTO plan;
     IF iteration > 0 THEN
       INSERT INTO benchmark_results VALUES (phase, q.name, iteration, plan);
     END IF;
   END LOOP;
 END LOOP;
END $$;

SELECT pg_temp.measure('before');
\ir ../../prisma/migrations/20261103070000_finding_analytics_indexes/migration.sql
ANALYZE "Finding";
SELECT pg_temp.measure('after');

-- Fail if the migration changes any result set (including page membership).
DO $$ BEGIN
 IF EXISTS (
   SELECT name FROM benchmark_fingerprints GROUP BY name
   HAVING count(DISTINCT fingerprint) <> 1
 ) THEN RAISE EXCEPTION 'Query results changed after indexing'; END IF;
END $$;

SELECT phase, name,
       round(percentile_cont(0.5) WITHIN GROUP
         (ORDER BY (plan->0->>'Execution Time')::double precision)::numeric, 3) AS median_ms
FROM benchmark_results GROUP BY phase, name ORDER BY name, phase;
SELECT phase, name, plan FROM benchmark_results WHERE run = 1 ORDER BY name, phase;
ROLLBACK;
