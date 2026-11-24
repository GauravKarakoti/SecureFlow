#!/usr/bin/env tsx
/**
 * Database Migration & Key Rotation Script for Finding Encryption (#2016)
 *
 * Encrypts existing unencrypted findings and rotates rows encrypted under older
 * key IDs to the current target key in configurable batches.
 *
 * Usage:
 *   npx tsx scripts/migrate-encrypt-findings.ts [options]
 *
 * Options:
 *   --batch-size <number>   Number of rows per batch (default: 100)
 *   --target-key-id <id>    Target encryption key ID (default: current active key ID)
 *   --dry-run               Scan and report rows without modifying the database
 *   --help, -h              Show this help message
 */

import prisma from "@/lib/prisma";
import {
  getActiveKeyId,
  isFindingEncryptionEnabled,
  resolvePrimaryEncryptionKey,
  rotateFindingsBatch,
  validateFindingEncryptionConfig,
  type RotationResult,
} from "@/lib/security/finding-encryption";

export interface MigrationCliArgs {
  batchSize: number;
  targetKeyId?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseCliArgs(args: string[]): MigrationCliArgs {
  let batchSize = 100;
  let targetKeyId: string | undefined = undefined;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--batch-size" && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        batchSize = parsed;
      }
    } else if (arg === "--target-key-id" && i + 1 < args.length) {
      targetKeyId = args[++i].trim();
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { batchSize, targetKeyId, dryRun, help };
}

export async function runMigration(
  args: MigrationCliArgs,
  prismaClient = prisma,
): Promise<RotationResult> {
  const targetKeyId = args.targetKeyId || getActiveKeyId();

  // Validate configuration before proceeding
  validateFindingEncryptionConfig();

  const primaryKey = resolvePrimaryEncryptionKey();
  if (!primaryKey) {
    throw new Error(
      "Cannot run migration: ENCRYPTION_KEY (or ENCRYPTION_KEY_FILE) is required to encrypt finding rows.",
    );
  }

  console.log(`[FindingEncryptionMigration] Starting migration...`);
  console.log(`  - Target Key ID: ${targetKeyId}`);
  console.log(`  - Batch Size:    ${args.batchSize}`);
  console.log(`  - Dry Run:       ${args.dryRun ? "YES (no writes)" : "NO"}`);

  const startTime = Date.now();
  const result = await rotateFindingsBatch(prismaClient, {
    batchSize: args.batchSize,
    targetKeyId,
    dryRun: args.dryRun,
    onProgress: (stats) => {
      console.log(
        `  -> Processed ${stats.processed} findings (${stats.reencrypted} encrypted/re-encrypted)...`,
      );
    },
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[FindingEncryptionMigration] Migration completed in ${durationSec}s:`);
  console.log(`  - Total Scanned:       ${result.totalScanned}`);
  console.log(`  - Encrypted/Rotated:   ${result.reencryptedCount}`);
  console.log(`  - Skipped (already ok):${result.skippedCount}`);
  console.log(`  - Failed:              ${result.failedCount}`);

  return result;
}

// Execute when invoked directly from CLI
if (process.env.NODE_ENV !== "test" && typeof process.env.VITEST === "undefined") {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  if (cliArgs.help) {
    console.log(`
Usage:
  npx tsx scripts/migrate-encrypt-findings.ts [options]

Options:
  --batch-size <number>   Batch size for chunked database updates (default: 100)
  --target-key-id <id>    Target encryption key ID (default: active key ID from env)
  --dry-run               Simulate migration without writing to database
  --help, -h              Show this help message
`);
    process.exit(0);
  }

  runMigration(cliArgs)
    .then((res) => {
      if (res.failedCount > 0) {
        console.error(`⚠️ Migration finished with ${res.failedCount} failed rows.`);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`❌ Migration failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
