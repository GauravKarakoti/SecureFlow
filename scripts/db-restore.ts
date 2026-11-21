#!/usr/bin/env tsx
/**
 * Database Restore CLI.
 *
 *   npm run db:restore -- --file=backups/secureflow_backup_xxx.dump
 *   npm run db:restore -- --file=backups/secureflow_backup_xxx.dump --force
 *
 * Refuses to restore into a non-empty database unless --force is given.
 */

import path from "node:path";
import { restoreDatabaseBackup, findLatestBackupFile } from "../src/lib/db/backup";
import { scrubCredentials } from "../src/lib/redaction";

function printUsage(): void {
  console.log(`
Usage: npm run db:restore -- --file=<path> [--force]

Options:
  --file=<path>     Path to backup archive (.dump or .sql). If omitted, uses latest in backups/
  --force           Required to restore into a non-empty database (overwrites existing tables)
  --help, -h        Show this help message

Environment Variables:
  DATABASE_URL      PostgreSQL connection string (required)
`);
}

export function parseArgs(argv: string[]): { file?: string; force: boolean; help: boolean } {
  const result: { file?: string; force: boolean; help: boolean } = { force: false, help: false };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--force") {
      result.force = true;
      continue;
    }
    if (arg.startsWith("--file=")) {
      result.file = arg.slice("--file=".length).trim();
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
      console.error(`❌ No backup file specified and none found in ${backupDir}. Provide --file=<path>.`);
      process.exit(1);
    }
    backupFile = latest;
    console.log(`ℹ️  No --file specified. Using most recent backup: ${backupFile}`);
  }

  try {
    const result = await restoreDatabaseBackup({
      backupFile,
      force: args.force,
    });

    console.log(`
======================================================
✅ SecureFlow Database Restore Completed Successfully
======================================================
  Source:   ${result.backupFile}
  Database: ${result.database}
  Duration: ${result.durationMs}ms
======================================================
`);
  } catch (err: any) {
    console.error(`❌ Restore failed: ${scrubCredentials(err?.message || String(err))}`);
    process.exit(1);
  }
}

// Only run automatically when executed directly
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  runCli();
}
