/**
 * Data Retention Cleanup CLI.
 *
 * Deletes older findings and audit logs in batches when DATA_RETENTION_DAYS is configured.
 * Note: `scripts/retention.ts` (`npm run retention`) is the primary unified retention
 * runner covering all data models with configurable `--days`, `--only`, and `--apply`.
 *
 * Usage:
 *   npm run cleanup                     # Dry-run — reports counts, deletes nothing
 *   npm run cleanup -- --apply          # Perform the cleanup
 *   npm run cleanup -- --days=30        # Specify retention days
 *   npm run cleanup -- --batch-size=200 # Rows per batch
 *   npm run cleanup -- --help           # Show this message
 *
 * Dry-run is the default. To perform deletions, pass --apply explicitly.
 * Never deletes users, repositories, or policies.
 */

import prisma from "../src/lib/prisma";
import {
  cleanupDataRetention,
  resolveDataRetentionDays,
  type CleanupOptions,
  type CleanupResult,
} from "../src/lib/retention/cleanup";

function usage(): string {
  const configuredDays = resolveDataRetentionDays();
  const statusStr = configuredDays
    ? `configured as ${configuredDays} days`
    : "not configured (off by default)";

  return [
    "Usage: npm run cleanup [-- options]",
    "",
    "Options:",
    "  --apply             Perform the deletion. Without this, runs as a dry-run.",
    "  --dry-run           Explicitly request a dry-run (the default).",
    "  --days=<n>          Retention period in days (overrides DATA_RETENTION_DAYS).",
    "  --batch-size=<n>    Rows deleted per batch statement (default 500).",
    "  --help, -h          Show this help message.",
    "",
    `Current DATA_RETENTION_DAYS: ${statusStr}`,
  ].join("\n");
}

export interface ParsedCleanupArgs extends CleanupOptions {
  help: boolean;
}

export function parseCleanupArgs(argv: string[]): ParsedCleanupArgs {
  const options: ParsedCleanupArgs = {
    dryRun: true, // dry-run by default!
    help: false,
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
      if (!Number.isInteger(val) || val < 1 || val > 3650) {
        throw new Error(`--days must be a whole number between 1 and 3650, got "${arg}".`);
      }
      options.days = val;
      continue;
    }

    if (arg.startsWith("--batch-size=")) {
      const val = Number(arg.slice("--batch-size=".length).trim());
      if (!Number.isInteger(val) || val < 1 || val > 10_000) {
        throw new Error(`--batch-size must be a whole number between 1 and 10000, got "${arg}".`);
      }
      options.batchSize = val;
      continue;
    }

    throw new Error(`Unrecognised argument "${arg}".\n\n${usage()}`);
  }

  return options;
}

export function formatCleanupReport(result: CleanupResult): string {
  const lines: string[] = [];

  lines.push("--------------------------------------------------");
  lines.push(
    `SecureFlow Data Retention Cleanup — ${result.dryRun ? "DRY RUN (nothing deleted)" : "APPLIED"}`,
  );
  lines.push("--------------------------------------------------");

  if (!result.enabled) {
    lines.push("Status: DISABLED");
    lines.push("DATA_RETENTION_DAYS is not set in environment.");
    lines.push("Pass --days=<n> or set DATA_RETENTION_DAYS in .env to enable.");
    return lines.join("\n");
  }

  lines.push(`Retention Window : ${result.retentionDays} days`);
  lines.push(`Cutoff Date      : ${result.cutoff}`);
  lines.push("");

  if (result.dryRun) {
    lines.push(`• Findings eligible for deletion  : ${result.findingsEligible ?? 0}`);
    lines.push(`• Audit logs eligible for deletion: ${result.auditLogsEligible ?? 0}`);
    lines.push(`Total rows eligible              : ${result.totalAffected}`);
    lines.push("");
    lines.push("Re-run with --apply to permanently delete these records.");
  } else {
    lines.push(`• Findings deleted  : ${result.findingsDeleted}`);
    lines.push(`• Audit logs deleted: ${result.auditLogsDeleted}`);
    lines.push(`Total rows deleted  : ${result.totalAffected}`);
  }

  lines.push("--------------------------------------------------");
  return lines.join("\n");
}

export async function runCleanupCli(
  argv: string[] = process.argv.slice(2),
  prismaClient = prisma,
): Promise<number> {
  let parsed: ParsedCleanupArgs;

  try {
    parsed = parseCleanupArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  try {
    const result = await cleanupDataRetention(prismaClient, parsed);
    console.log(formatCleanupReport(result));
    return 0;
  } catch (err) {
    console.error("Cleanup error:", (err as Error).message);
    return 1;
  }
}

// Self-executing if run directly
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  runCleanupCli().then((code) => {
    process.exit(code);
  });
}
