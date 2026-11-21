#!/usr/bin/env tsx
/**
 * Database Backup Verification CLI.
 *
 *   npm run db:verify-backup
 *   npm run db:verify-backup -- --file=backups/secureflow_backup_xxx.dump
 *
 * Restores a backup into an ephemeral database, verifies table counts and
 * Prisma schema migrations, and cleans up the temporary database.
 */

import path from "node:path";
import { verifyDatabaseBackup, findLatestBackupFile } from "../src/lib/db/backup";
import { scrubCredentials } from "../src/lib/redaction";

function printUsage(): void {
  console.log(`
Usage: npm run db:verify-backup [-- options]

Options:
  --file=<path>       Path to backup archive to verify. If omitted, uses latest in backups/
  --temp-db=<name>    Custom temporary database name to use for verification
  --keep-temp         Keep temporary database after verification (default: cleans up automatically)
  --help, -h          Show this help message

Environment Variables:
  DATABASE_URL        PostgreSQL connection string (required)
`);
}

export function parseArgs(argv: string[]): {
  file?: string;
  tempDb?: string;
  keepTemp: boolean;
  help: boolean;
} {
  const result: { file?: string; tempDb?: string; keepTemp: boolean; help: boolean } = {
    keepTemp: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--keep-temp") {
      result.keepTemp = true;
      continue;
    }
    if (arg.startsWith("--file=")) {
      result.file = arg.slice("--file=".length).trim();
      continue;
    }
    if (arg.startsWith("--temp-db=")) {
      result.tempDb = arg.slice("--temp-db=".length).trim();
      continue;
    }
    throw new Error(`Unrecognised argument: "${arg}". Run with --help for usage.`);
  }

  return result;
}

export async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  let backupFile = args.file;
  if (!backupFile) {
    const backupDir = path.resolve(process.cwd(), "backups");
    const latest = findLatestBackupFile(backupDir);
    if (!latest) {
      console.error(
        `❌ No backup file specified and none found in ${backupDir}. Provide --file=<path>.`,
      );
      process.exit(1);
    }
    backupFile = latest;
    console.log(`ℹ️  No --file specified. Verifying most recent backup: ${backupFile}`);
  }

  try {
    const result = await verifyDatabaseBackup({
      backupFile,
      tempDbName: args.tempDb,
      keepTempDb: args.keepTemp,
    });

    console.log(`
======================================================
✅ SecureFlow Backup Verification PASSED
======================================================
  Backup:     ${result.backupFile}
  Ephemeral:  ${result.tempDbName} (dropped after verification)
  Tables:     ${result.tablesVerified} tables verified
  Migrations: ${result.migrationsVerified} Prisma migrations valid
  Duration:   ${result.durationMs}ms
======================================================
`);
  } catch (err: unknown) {
    const rawDetail = err instanceof Error ? err.message : String(err);
    const safeDetail = scrubCredentials(rawDetail);
    console.error(`❌ Backup verification FAILED: ${safeDetail}`);
    process.exit(1);
  }
}

// Only run automatically when executed directly
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  runCli();
}
