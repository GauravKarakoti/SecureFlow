/**
 * Database Old Data Purge Script
 *
 * Purges findings, scan records, and audit entries older than DATA_RETENTION_DAYS in batches.
 * Note: `scripts/retention.ts` (`npm run retention`) is the primary unified retention
 * runner covering all data models with configurable `--days`, `--only`, and `--apply`.
 *
 * Options:
 *   --dry-run (default)   Count and print records eligible for deletion without deleting.
 *   --apply               Perform the deletion.
 *   --days=<n>            Override DATA_RETENTION_DAYS.
 *   --batch-size=<n>      Number of records to delete per batch (default 500).
 */

import prisma from "../src/lib/prisma";
import { parseDataRetentionDays } from "../src/lib/retention/cleanup";
import { calculateRetentionCutoff } from "../src/lib/retention/policy";
import { DEFAULT_BATCH_SIZE } from "../src/lib/retention/purge";

export const DEFAULT_PURGE_BATCH_SIZE = DEFAULT_BATCH_SIZE;

export interface PurgeOptions {
  dryRun?: boolean;
  days?: number;
  batchSize?: number;
  now?: Date;
  env?: Record<string, string | undefined>;
}

export interface PurgeResult {
  enabled: boolean;
  dryRun: boolean;
  retentionDays: number | null;
  cutoff: string | null;
  findingsCount: number;
  scansCount: number;
  auditLogsCount: number;
  totalAffected: number;
  message: string;
}

export function calculateDateCutoff(days: number, now: Date = new Date()): Date {
  return calculateRetentionCutoff(days, now);
}

export function parsePurgeArgs(argv: string[]): {
  dryRun: boolean;
  days?: number;
  batchSize?: number;
  help?: boolean;
} {
  const options = {
    dryRun: true,
    help: false,
    days: undefined as number | undefined,
    batchSize: undefined as number | undefined,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--apply") {
      options.dryRun = false;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--days=")) {
      const val = Number(arg.slice("--days=".length).trim());
      if (!Number.isInteger(val) || val < 1) {
        throw new Error(`--days must be a positive integer, got "${arg}".`);
      }
      options.days = val;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      const val = Number(arg.slice("--batch-size=".length).trim());
      if (!Number.isInteger(val) || val < 1) {
        throw new Error(`--batch-size must be a positive integer, got "${arg}".`);
      }
      options.batchSize = val;
      continue;
    }
  }

  return options;
}

export async function purgeOldData(db: any, options: PurgeOptions = {}): Promise<PurgeResult> {
  const env = options.env ?? process.env;
  const days =
    options.days !== undefined ? options.days : parseDataRetentionDays(env.DATA_RETENTION_DAYS);
  const dryRun = options.dryRun ?? true;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE);
  const now = options.now ?? new Date();

  // If DATA_RETENTION_DAYS is unset and no explicit days provided, do nothing.
  if (days === null || days === undefined) {
    return {
      enabled: false,
      dryRun,
      retentionDays: null,
      cutoff: null,
      findingsCount: 0,
      scansCount: 0,
      auditLogsCount: 0,
      totalAffected: 0,
      message: "DATA_RETENTION_DAYS is not configured. Nothing was deleted.",
    };
  }

  const cutoff = calculateDateCutoff(days, now);

  if (dryRun) {
    const findingsCount = await db.finding.count({
      where: { createdAt: { lt: cutoff } },
    });
    const scansCount = await db.scanResult.count({
      where: { createdAt: { lt: cutoff } },
    });
    const auditLogsCount = await db.auditLog.count({
      where: { timestamp: { lt: cutoff } },
    });

    const totalAffected = findingsCount + scansCount + auditLogsCount;

    return {
      enabled: true,
      dryRun: true,
      retentionDays: days,
      cutoff: cutoff.toISOString(),
      findingsCount,
      scansCount,
      auditLogsCount,
      totalAffected,
      message: `Dry-run: ${findingsCount} finding(s), ${scansCount} scan(s), and ${auditLogsCount} audit log(s) older than ${days} days would be deleted.`,
    };
  }

  // 1. Delete findings in batches
  let findingsDeleted = 0;
  while (true) {
    const batch = await db.finding.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (batch.length === 0) break;

    const ids = batch.map((r: { id: string }) => r.id);
    const del = await db.finding.deleteMany({
      where: { id: { in: ids } },
    });
    findingsDeleted += del.count;
    if (batch.length < batchSize) break;
  }

  // 2. Delete scans in batches
  let scansDeleted = 0;
  while (true) {
    const batch = await db.scanResult.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (batch.length === 0) break;

    const ids = batch.map((r: { id: string }) => r.id);
    const del = await db.scanResult.deleteMany({
      where: { id: { in: ids } },
    });
    scansDeleted += del.count;
    if (batch.length < batchSize) break;
  }

  // 3. Delete audit logs in batches
  let auditLogsDeleted = 0;
  while (true) {
    const batch = await db.auditLog.findMany({
      where: { timestamp: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (batch.length === 0) break;

    const ids = batch.map((r: { id: string }) => r.id);
    const del = await db.auditLog.deleteMany({
      where: { id: { in: ids } },
    });
    auditLogsDeleted += del.count;
    if (batch.length < batchSize) break;
  }

  const totalAffected = findingsDeleted + scansDeleted + auditLogsDeleted;

  // 4. Record run in audit log
  if (typeof db.auditLog?.create === "function") {
    try {
      await db.auditLog.create({
        data: {
          userId: null,
          action: "DATA_PURGE",
          resource: "system",
          decision: "ALLOW",
          metadata: {
            retentionDays: days,
            cutoff: cutoff.toISOString(),
            findingsDeleted,
            scansDeleted,
            auditLogsDeleted,
            totalAffected,
            dryRun: false,
          },
        },
      });
    } catch (err) {
      console.error("[DATA_PURGE] Failed to record audit log:", err);
    }
  }

  return {
    enabled: true,
    dryRun: false,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    findingsCount: findingsDeleted,
    scansCount: scansDeleted,
    auditLogsCount: auditLogsDeleted,
    totalAffected,
    message: `Purged ${findingsDeleted} finding(s), ${scansDeleted} scan(s), and ${auditLogsDeleted} audit log(s) older than ${days} days.`,
  };
}

export async function runPurgeCli(
  argv: string[] = process.argv.slice(2),
  db = prisma,
): Promise<number> {
  const args = parsePurgeArgs(argv);

  if (args.help) {
    console.log(
      [
        "Usage: npm run db:purge [-- options]",
        "",
        "Options:",
        "  --dry-run        Dry-run (default: reports counts, deletes nothing)",
        "  --apply          Perform real deletion",
        "  --days=<n>       Override DATA_RETENTION_DAYS",
        "  --batch-size=<n> Batch size (default: 500)",
        "  --help, -h       Show help",
      ].join("\n"),
    );
    return 0;
  }

  const result = await purgeOldData(db, args);
  console.log(result.message);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  runPurgeCli().then((code) => {
    process.exit(code);
  });
}
