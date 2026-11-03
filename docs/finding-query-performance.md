# Finding query indexes

## Query review

`Finding` has `scanResultId`, `severity`, and `createdAt`; repository ownership
is reached through `ScanResult -> PullRequest -> Repository`. It has no
`repositoryId` or `status` columns. Triage status lives in `FindingTriage`.

The schema already indexes `Repository.userId`,
`PullRequest(repositoryId, createdAt DESC)`,
`PullRequest(repositoryId, status)`,
`ScanResult(pullRequestId, createdAt DESC)`, and
`FindingTriage(repositoryId, status)`. Duplicating these indexes would increase
write cost without addressing the remaining finding-table access paths.

The migration adds:

- `Finding(scanResultId, createdAt DESC)`: narrows the date window within each
  owned scan for `fetchSeverityTrend` and `fetchTopFindingTypes` in
  `src/lib/analytics/scan-history.ts`. It also supports newest findings within a scan.
- `Finding(scanResultId, severity, createdAt DESC)`: supports a severity bucket
  within a scan in date order. It replaces the existing `(scanResultId, severity)`
  index, preserving its complete equality prefix.

The user-wide findings action in `src/lib/actions/findings.ts` also applies
ownership joins and combines multiple scans. A per-scan ordered index does not
guarantee that its final global ordering avoids a sort. No authorization or
pagination predicates change here.

## Reproduce the benchmark

Use a disposable PostgreSQL database with the **pre-migration** schema. Do not
run this fixture against production. From the repository root, with dependencies
installed and a valid dummy `DATABASE_POOL_URL` for loading Prisma configuration:

```sh
# Use main's schema at 494a8515049b42138707cbbf19443bfd1a54962a.
git show 494a8515049b42138707cbbf19443bfd1a54962a:prisma/schema.prisma > /tmp/secureflow-before.prisma
npx prisma migrate diff --from-empty --to-schema /tmp/secureflow-before.prisma --script --output /tmp/secureflow-before.sql
psql "$BENCHMARK_DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/secureflow-before.sql
psql "$BENCHMARK_DATABASE_URL" -f scripts/benchmarks/finding-indexes.sql
```

The script inserts 50 users/repositories, 500 pull requests/scans, and 500,000
findings (1,000 per scan, five severity buckets, dates spread over a year).
All existing indexes are present in the baseline. It runs `ANALYZE`, keeps the
default planner settings, warms each query once, and records five executions
with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on each side of the actual migration.
It checks identical result-ID fingerprints, including limited-page membership,
and rolls back both fixture data and index changes. Full first-run plans and
median execution times are printed for inspection.

## Measured results

Measured on 2026-11-03 with PostgreSQL 18.6 (Debian, x86_64) in an isolated Docker
container under WSL2, using tmpfs storage and warm caches. Times below are
server execution medians in milliseconds, excluding network/Prisma overhead.

| Query                                          | Before | After |
| ---------------------------------------------- | -----: | ----: |
| Owned findings in a seven-day analytics window |  1.102 | 0.140 |
| Newest 20 findings in one scan                 |  3.862 | 0.010 |
| Newest 20 critical findings in one scan        |  0.037 | 0.013 |

The analytics query returns 189 rows. Before, the scan-ID index fetches roughly
1,000 findings per scan and discards about 981 on the date filter. After, the new
`Finding_scanResultId_createdAt_idx` applies both scan and date bounds in the
index condition. The first recorded plan uses 253 shared-buffer hits instead of
486; the final cross-scan sort remains.

For the newest-page microbenchmark, the old global date index reads and rejects
13,178 other-scan rows (13,225 buffer hits). The new scan/date index reads the
20 requested rows (23 hits). For the severity-page microbenchmark, the old
scan/severity index reads 200 rows then performs a top-N sort (45 hits); the new
scan/severity/date index reads 20 rows in order (23 hits).

These are synthetic query measurements, not dashboard response-time promises.
The two single-scan page queries isolate the index access paths; they are not
measurements of an entire user-wide findings request. `fetchRepoSummaries` still
hydrates historical relations, which this migration does not bound. Actual
benefit depends on ownership selectivity, dates, cache state, data skew, and
PostgreSQL version. Re-run the script on representative staging data.

## Deployment considerations

There is one net additional index, plus a wider replacement index. Both consume
storage and add work to inserts/deletes. The migration builds replacements before
dropping the old severity index. Standard `CREATE INDEX` blocks table writes
while building, so schedule the migration for a maintenance window on large
deployments, or have the database operator stage concurrent index creation under
the deployment's established migration procedure. No data backfill is required.
