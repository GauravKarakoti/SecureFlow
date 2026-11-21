#!/usr/bin/env tsx
/**
 * Database Backup CLI.
 *
 *   npm run db:backup
 *   npm run db:backup -- --output=backups/custom_name.dump
 *   npm run db:backup -- --dir=/var/backups/secureflow
 */

import { createDatabaseBackup } from "../src/lib/db/backup";
import { scrubCredentials } from "../src/lib/redaction";

function printUsage(): void {
  console.log(`
Usage: npm run db:backup [-- options]

Options:
  --output=<path>   Full destination file path (e.g. backups/my_backup.dump)
  --dir=<path>      Directory to store timestamped backup (default: backups/)
  --help, -h        Show this help message

Environment Variables:
  DATABASE_URL      PostgreSQL connection string (required)
`);
}

export function parseArgs(argv: string[]): {
  outputFile?: string;
  outputDir?: string;
  help: boolean;
} {
  const result: { outputFile?: string; outputDir?: string; help: boolean } = { help: false };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg.startsWith("--output=")) {
      result.outputFile = arg.slice("--output=".length).trim();
      continue;
    }
    if (arg.startsWith("--dir=")) {
      result.outputDir = arg.slice("--dir=".length).trim();
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

  try {
    const result = await createDatabaseBackup({
      outputDir: args.outputDir,
      outputFile: args.outputFile,
    });

    console.log(`
======================================================
✅ SecureFlow Database Backup Created Successfully
======================================================
  File:     ${result.filePath}
  Size:     ${(result.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB (${result.fileSizeBytes} bytes)
  Database: ${result.database}
  Duration: ${result.durationMs}ms
  Format:   PostgreSQL Custom Compressed Archive (-Fc)
======================================================
`);
  } catch (err: unknown) {
    const rawDetail = err instanceof Error ? err.message : String(err);
    const safeDetail = scrubCredentials(rawDetail);
    console.error(`❌ Backup failed: ${safeDetail}`);
    process.exit(1);
  }
}

// Only run automatically when executed directly
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  runCli();
}
