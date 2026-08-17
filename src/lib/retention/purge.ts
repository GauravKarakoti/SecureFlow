/**
 * Retention executor.
 *
 * Three properties matter more than throughput here:
 *
 *  1. **Dry-run by default.** A destructive job must be opted into explicitly,
 *     and must be able to report exactly what it would remove before anyone
 *     lets it remove anything.
 *  2. **Bounded batches.** A first run against a table that has been growing
 *     for a year should not take a long lock or pull the whole table into
 *     memory.
 *  3. **Snippet redaction is not deletion.** Findings past the snippet window
 *     have `codeSnippet` cleared while the row survives, so the security
 *     history (type, severity, file, fingerprint) outlives the copied source.
 *
 * Every run records what it did in `AuditLog`, so the purge is itself auditable.
 */

import {
  resolveRetentionPolicy,
  type PurgeTarget,
  type ResolvedRetention,
} from './policy';

/** Rows touched per statement. Small enough to keep locks short. */
export const DEFAULT_BATCH_SIZE = 500;

/** Ceiling on batches per target per run, so one invocation always terminates. */
export const MAX_BATCHES_PER_TARGET = 200;

/**
 * Triage statuses that pin a finding in place.
 *
 * A finding a reviewer has not finished with must never be purged or redacted
 * out from under them — the snippet is the thing they are looking at. Mirrors
 * the inverse of `SUPPRESSED_STATUSES`: anything not yet resolved or dismissed
 * is still live work.
 */
export const PROTECTED_TRIAGE_STATUSES = ['OPEN'] as const;

/** Replacement text left in place of a redacted snippet. */
export const REDACTED_SNIPPET = '[REDACTED — retention policy]';

export interface PurgeOptions {
  /** When false, nothing is written. Defaults to true. */
  dryRun?: boolean;
  /** Rows per statement. Defaults to `DEFAULT_BATCH_SIZE`. */
  batchSize?: number;
  /** Restrict the run to these targets. Defaults to all of them. */
  only?: PurgeTarget[];
  /** Injected for tests. */
  now?: Date;
  /** Injected for tests. */
  env?: Record<string, string | undefined>;
}

export interface TargetOutcome {
  target: PurgeTarget;
  /** Rows deleted, or redacted for `findingSnippet`. */
  affected: number;
  /** Cutoff applied — rows older than this were in scope. */
  cutoff: string;
  retentionDays: number;
  batches: number;
  /** True when the batch ceiling stopped the run before the target was drained. */
  truncated: boolean;
  /** Present when the target failed; the run continues with the others. */
  error?: string;
}

export interface PurgeReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  outcomes: TargetOutcome[];
  totalAffected: number;
  /** True when any target reported an error. */
  hadErrors: boolean;
}

/** The Prisma surface this module uses, narrowed so tests can supply a stub. */
export interface PurgeClient {
  auditLog: {
    count: (args: unknown) => Promise<number>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
    create: (args: unknown) => Promise<unknown>;
  };
  webhookEvent: {
    count: (args: unknown) => Promise<number>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
  };
  scanResult: {
    count: (args: unknown) => Promise<number>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
  };
  finding: {
    count: (args: unknown) => Promise<number>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
  };
  findingTriage: {
    findMany: (args: unknown) => Promise<Array<{ fingerprint: string }>>;
  };
}

/**
 * Fingerprints that must not be touched because a reviewer still has them open.
 *
 * Bounded by the number of open triage decisions, which is a human-scale number
 * — this is not the same as loading every finding.
 */
async function loadProtectedFingerprints(db: PurgeClient): Promise<string[]> {
  const rows = await db.findingTriage.findMany({
    where: { status: { in: [...PROTECTED_TRIAGE_STATUSES] } },
    select: { fingerprint: true },
  });

  return [...new Set(rows.map((row) => row.fingerprint))];
}

/**
 * Run one target to completion in batches.
 *
 * `selectIds` finds the next batch, `apply` acts on it. Splitting them this way
 * keeps the batching identical across delete and redact, and means a dry run can
 * count without a second code path that could disagree with the real one.
 */
async function runBatched(
  selectIds: (take: number) => Promise<Array<{ id: string }>>,
  apply: (ids: string[]) => Promise<{ count: number }>,
  batchSize: number,
  dryRun: boolean
): Promise<{ affected: number; batches: number; truncated: boolean }> {
  let affected = 0;
  let batches = 0;

  while (batches < MAX_BATCHES_PER_TARGET) {
    const rows = await selectIds(batchSize);
    if (rows.length === 0) {
      return { affected, batches, truncated: false };
    }

    batches += 1;

    if (dryRun) {
      // Count what would be affected, then stop: without a write the same rows
      // would be selected forever.
      affected += rows.length;
      if (rows.length < batchSize) return { affected, batches, truncated: false };
      // A full batch means there is more; report the ceiling honestly rather
      // than looping over rows we are not going to change.
      return { affected, batches, truncated: true };
    }

    const { count } = await apply(rows.map((row) => row.id));
    affected += count;

    if (rows.length < batchSize) {
      return { affected, batches, truncated: false };
    }
  }

  return { affected, batches, truncated: true };
}

async function purgeAuditLogs(
  db: PurgeClient,
  rule: ResolvedRetention,
  batchSize: number,
  dryRun: boolean
) {
  return runBatched(
    (take) =>
      db.auditLog.findMany({
        where: { timestamp: { lt: rule.cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => db.auditLog.deleteMany({ where: { id: { in: ids } } }),
    batchSize,
    dryRun
  );
}

async function purgeWebhookEvents(
  db: PurgeClient,
  rule: ResolvedRetention,
  batchSize: number,
  dryRun: boolean
) {
  return runBatched(
    (take) =>
      db.webhookEvent.findMany({
        where: { createdAt: { lt: rule.cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => db.webhookEvent.deleteMany({ where: { id: { in: ids } } }),
    batchSize,
    dryRun
  );
}

async function purgeScanResults(
  db: PurgeClient,
  rule: ResolvedRetention,
  batchSize: number,
  dryRun: boolean
) {
  // Findings go with their ScanResult via the existing onDelete: Cascade.
  return runBatched(
    (take) =>
      db.scanResult.findMany({
        where: { createdAt: { lt: rule.cutoff } },
        select: { id: true },
        take,
      }),
    (ids) => db.scanResult.deleteMany({ where: { id: { in: ids } } }),
    batchSize,
    dryRun
  );
}

async function redactFindingSnippets(
  db: PurgeClient,
  rule: ResolvedRetention,
  batchSize: number,
  dryRun: boolean,
  protectedFingerprints: string[]
) {
  const where = {
    createdAt: { lt: rule.cutoff },
    // Already-redacted rows must not be re-selected, or the loop never drains.
    codeSnippet: { not: null as null, notIn: [REDACTED_SNIPPET] },
    ...(protectedFingerprints.length > 0
      ? { fingerprint: { notIn: protectedFingerprints } }
      : {}),
  };

  return runBatched(
    (take) => db.finding.findMany({ where, select: { id: true }, take }),
    (ids) =>
      db.finding.updateMany({
        where: { id: { in: ids } },
        data: { codeSnippet: REDACTED_SNIPPET },
      }),
    batchSize,
    dryRun
  );
}

/**
 * Execute the retention policy.
 *
 * Targets run sequentially rather than concurrently: they contend for the same
 * connection pool, and a purge has no deadline worth optimising against.
 *
 * A target that throws is recorded and the run continues — one failing table
 * should not stop the others from being cleaned up.
 */
export async function runRetention(
  db: PurgeClient,
  options: PurgeOptions = {}
): Promise<PurgeReport> {
  const dryRun = options.dryRun ?? true;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();

  const policy = resolveRetentionPolicy(options.env, now);
  const selected = options.only?.length
    ? policy.filter((rule) => options.only!.includes(rule.target))
    : policy;

  // Loaded once, up front: the set does not change during the run, and querying
  // it per batch would be a needless round trip per batch.
  const protectedFingerprints = selected.some((r) => r.target === 'findingSnippet')
    ? await loadProtectedFingerprints(db)
    : [];

  const outcomes: TargetOutcome[] = [];

  for (const rule of selected) {
    const base = {
      target: rule.target,
      cutoff: rule.cutoff.toISOString(),
      retentionDays: rule.days,
    };

    try {
      let outcome: { affected: number; batches: number; truncated: boolean };

      switch (rule.target) {
        case 'auditLog':
          outcome = await purgeAuditLogs(db, rule, batchSize, dryRun);
          break;
        case 'webhookEvent':
          outcome = await purgeWebhookEvents(db, rule, batchSize, dryRun);
          break;
        case 'scanResult':
          outcome = await purgeScanResults(db, rule, batchSize, dryRun);
          break;
        case 'findingSnippet':
          outcome = await redactFindingSnippets(db, rule, batchSize, dryRun, protectedFingerprints);
          break;
      }

      outcomes.push({ ...base, ...outcome });
    } catch (error) {
      outcomes.push({
        ...base,
        affected: 0,
        batches: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: PurgeReport = {
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcomes,
    totalAffected: outcomes.reduce((sum, outcome) => sum + outcome.affected, 0),
    hadErrors: outcomes.some((outcome) => outcome.error !== undefined),
  };

  await recordPurge(db, report);

  return report;
}

/**
 * Write a summary of the run to the audit log.
 *
 * Skipped on a dry run — a report of what *would* happen is not an event worth
 * an audit row, and writing one would pollute the very table being purged.
 *
 * A failure here is swallowed deliberately: the purge already happened, and
 * throwing now would make a successful run look like a failed one to whatever
 * scheduler invoked it.
 */
async function recordPurge(db: PurgeClient, report: PurgeReport): Promise<void> {
  if (report.dryRun) return;

  try {
    await db.auditLog.create({
      data: {
        userId: null,
        action: 'RETENTION_PURGE',
        resource: 'system',
        decision: report.hadErrors ? 'PARTIAL' : 'ALLOW',
        metadata: {
          totalAffected: report.totalAffected,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          outcomes: report.outcomes,
        },
      },
    });
  } catch {
    // Non-fatal; see the docstring.
  }
}

/** Render a report as human-readable lines for the CLI. */
export function formatReport(report: PurgeReport): string {
  const lines: string[] = [];
  const mode = report.dryRun ? 'DRY RUN — nothing was written' : 'APPLIED';

  lines.push(`SecureFlow data retention — ${mode}`);
  lines.push(`Started ${report.startedAt}`);
  lines.push('');

  for (const outcome of report.outcomes) {
    const verb = outcome.target === 'findingSnippet' ? 'redact' : 'delete';
    const label = `${outcome.target} (older than ${outcome.retentionDays}d, before ${outcome.cutoff})`;

    if (outcome.error) {
      lines.push(`  ✗ ${label}: FAILED — ${outcome.error}`);
      continue;
    }

    const suffix = outcome.truncated ? ' (more remain — run again)' : '';
    const tense = report.dryRun ? `would ${verb}` : `${verb}d`;
    lines.push(`  • ${label}: ${tense} ${outcome.affected} row(s)${suffix}`);
  }

  lines.push('');
  lines.push(`Total affected: ${report.totalAffected}`);
  if (report.hadErrors) lines.push('One or more targets failed — see above.');

  return lines.join('\n');
}
