/**
 * Data retention cleanup engine for self-hosted SecureFlow instances.
 *
 * Automatically deletes older findings and audit logs in bounded batches
 * when DATA_RETENTION_DAYS is configured. Off by default.
 *
 * Safety Guarantees:
 *  - Off by default: Without DATA_RETENTION_DAYS or an explicit override, no data is deleted.
 *  - Dry-run mode: When requested or by default in CLI, only counts and reports rows without deleting anything.
 *  - Bounded batching: Prevents long database table locks and memory exhaustion.
 *  - Integrity: Never deletes users, repositories, or policies.
 */

import {
  RetentionConfigError,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  calculateRetentionCutoff,
} from "./policy";

export { calculateRetentionCutoff };

/** Default rows touched per batch statement. */
export const DEFAULT_CLEANUP_BATCH_SIZE = 500;

/** Minimal Prisma interface needed for cleanup execution. */
export interface CleanupPrismaClient {
  finding: {
    count: (args: any) => Promise<number>;
    findMany: (args: any) => Promise<Array<{ id: string }>>;
    deleteMany: (args: any) => Promise<{ count: number }>;
  };
  auditLog: {
    count: (args: any) => Promise<number>;
    findMany: (args: any) => Promise<Array<{ id: string }>>;
    deleteMany: (args: any) => Promise<{ count: number }>;
    create?: (args: any) => Promise<any>;
  };
}

export interface CleanupOptions {
  /** Explicit retention window in days. If omitted, reads DATA_RETENTION_DAYS from env. */
  days?: number;
  /** When true, only counts eligible rows and deletes nothing. */
  dryRun?: boolean;
  /** Number of rows deleted per batch statement. Defaults to 500. */
  batchSize?: number;
  /** Reference timestamp injected for tests. Defaults to now. */
  now?: Date;
  /** Environment variable map injected for tests. */
  env?: Record<string, string | undefined>;
}

export interface CleanupResult {
  success: boolean;
  enabled: boolean;
  dryRun: boolean;
  retentionDays: number | null;
  cutoff: string | null;
  findingsDeleted: number;
  auditLogsDeleted: number;
  findingsEligible?: number;
  auditLogsEligible?: number;
  totalAffected: number;
  message: string;
}

/**
 * Parse DATA_RETENTION_DAYS from raw string.
 * Returns null if unset or blank (off by default).
 * Throws RetentionConfigError if present but invalid.
 */
export function parseDataRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  const parsed = Number(raw.trim());

  if (!Number.isInteger(parsed)) {
    throw new RetentionConfigError(
      `DATA_RETENTION_DAYS must be a whole number of days, got "${raw}".`,
    );
  }

  if (parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `DATA_RETENTION_DAYS must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days, got ${parsed}.`,
    );
  }

  return parsed;
}

/**
 * Resolve the configured DATA_RETENTION_DAYS from environment.
 * Returns null if unset, meaning retention cleanup is disabled.
 */
export function resolveDataRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number | null {
  return parseDataRetentionDays(env.DATA_RETENTION_DAYS);
}

/**
 * Clean up older findings and audit logs in bounded batches.
 *
 * If retention is not configured (DATA_RETENTION_DAYS is unset and options.days is not given),
 * no rows are deleted and the function returns with enabled: false.
 *
 * Never deletes users, repositories, or policies.
 */
export async function cleanupDataRetention(
  db: CleanupPrismaClient,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const dryRun = options.dryRun ?? false;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_CLEANUP_BATCH_SIZE);
  const now = options.now ?? new Date();

  const days = options.days !== undefined ? options.days : resolveDataRetentionDays(options.env);

  // If retention is not configured, exit safely without deleting anything.
  if (days === null || days === undefined) {
    return {
      success: true,
      enabled: false,
      dryRun,
      retentionDays: null,
      cutoff: null,
      findingsDeleted: 0,
      auditLogsDeleted: 0,
      totalAffected: 0,
      message: "DATA_RETENTION_DAYS is not configured (retention cleanup is off by default).",
    };
  }

  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `Retention days must be a whole number between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, got ${days}.`,
    );
  }

  const cutoff = calculateRetentionCutoff(days, now);

  // 1. Dry-run mode: Count and report without deleting anything.
  if (dryRun) {
    const findingsEligible = await db.finding.count({
      where: { createdAt: { lt: cutoff } },
    });

    const auditLogsEligible = await db.auditLog.count({
      where: { timestamp: { lt: cutoff } },
    });

    const totalAffected = findingsEligible + auditLogsEligible;

    return {
      success: true,
      enabled: true,
      dryRun: true,
      retentionDays: days,
      cutoff: cutoff.toISOString(),
      findingsDeleted: 0,
      auditLogsDeleted: 0,
      findingsEligible,
      auditLogsEligible,
      totalAffected,
      message: `Dry run: ${findingsEligible} finding(s) and ${auditLogsEligible} audit log(s) older than ${days} days would be deleted.`,
    };
  }

  // 2. Batched deletion of older findings.
  let findingsDeleted = 0;
  while (true) {
    const batch = await db.finding.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });

    if (batch.length === 0) break;

    const ids = batch.map((r) => r.id);
    const deleteResult = await db.finding.deleteMany({
      where: { id: { in: ids } },
    });

    findingsDeleted += deleteResult.count;
    if (batch.length < batchSize) break;
  }

  // 3. Batched deletion of older audit logs.
  let auditLogsDeleted = 0;
  while (true) {
    const batch = await db.auditLog.findMany({
      where: { timestamp: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });

    if (batch.length === 0) break;

    const ids = batch.map((r) => r.id);
    const deleteResult = await db.auditLog.deleteMany({
      where: { id: { in: ids } },
    });

    auditLogsDeleted += deleteResult.count;
    if (batch.length < batchSize) break;
  }

  const totalAffected = findingsDeleted + auditLogsDeleted;

  // 4. Record the cleanup action in AuditLog if available (with current timestamp so it is kept).
  if (typeof db.auditLog.create === "function") {
    try {
      await db.auditLog.create({
        data: {
          userId: null,
          action: "DATA_RETENTION_CLEANUP",
          resource: "system",
          decision: "ALLOW",
          metadata: {
            retentionDays: days,
            cutoff: cutoff.toISOString(),
            findingsDeleted,
            auditLogsDeleted,
            totalAffected,
            dryRun: false,
          },
        },
      });
    } catch (err) {
      // Non-fatal: an audit write failure must not turn a successful cleanup into an error.
      console.error("[DATA_RETENTION] Failed to record audit log:", err);
    }
  }

  return {
    success: true,
    enabled: true,
    dryRun: false,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    findingsDeleted,
    auditLogsDeleted,
    totalAffected,
    message: `Successfully deleted ${findingsDeleted} finding(s) and ${auditLogsDeleted} audit log(s) older than ${days} days.`,
  };
}
