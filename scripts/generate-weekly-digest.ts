#!/usr/bin/env tsx
/**
 * Weekly Security Digest Generator (#1788)
 *
 * Scans all repositories for new findings, triage changes, and blocked PRs,
 * generates structured weekly digests, and optionally sends notification emails.
 *
 * Usage:
 *   npx tsx scripts/generate-weekly-digest.ts
 *   npx tsx scripts/generate-weekly-digest.ts --user=usr_123
 *   npx tsx scripts/generate-weekly-digest.ts --force
 *   npx tsx scripts/generate-weekly-digest.ts --dry-run
 *   npx tsx scripts/generate-weekly-digest.ts --no-email
 *   npx tsx scripts/generate-weekly-digest.ts --help
 */

import prisma from "../src/lib/prisma";
import {
  generateWeeklyDigestForUser,
  generateAllWeeklyDigests,
  calculateDigestMetricsForUser,
  SEVEN_DAYS_MS,
} from "../src/lib/digest/digest-service";
import { renderDigestText } from "../src/lib/digest/email-template";
import { MockMailTransport } from "../src/lib/email/mail-transport";

export interface CliOptions {
  userId?: string;
  force: boolean;
  dryRun: boolean;
  noEmail: boolean;
  help: boolean;
  quiet: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    force: false,
    dryRun: false,
    noEmail: false,
    help: false,
    quiet: false,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-email") {
      options.noEmail = true;
    } else if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else if (arg.startsWith("--user=")) {
      options.userId = arg.slice(7).trim();
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
SecureFlow - Weekly Security Digest Generator (#1788)

Generates weekly digests summarizing findings, repeat offenders, and blocked PRs.

Options:
  --user=<id>     Generate digest only for the specified user ID
  --force         Force generation even if a digest was created in the last 7 days
  --dry-run       Calculate and render digest preview without database writes or sending emails
  --no-email      Store digest in database but skip sending notification emails
  --quiet, -q     Suppress informational output
  --help, -h      Show this help message

Examples:
  npx tsx scripts/generate-weekly-digest.ts
  npx tsx scripts/generate-weekly-digest.ts --user=usr_abc123 --force
  npx tsx scripts/generate-weekly-digest.ts --dry-run
`);
}

export async function runWeeklyDigestCli(
  args: string[] = process.argv.slice(2),
): Promise<{ success: boolean; generated: number; skipped: number; errors: number }> {
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    return { success: true, generated: 0, skipped: 0, errors: 0 };
  }

  const log = (msg: string) => {
    if (!options.quiet) {
      console.log(msg);
    }
  };

  log("=================================================");
  log("SecureFlow - Weekly Security Digest Job (#1788)");
  log("=================================================");
  if (options.dryRun) log("[Mode: DRY-RUN (No writes, no emails sent)]");
  if (options.force) log("[Option: FORCE generation enabled]");
  if (options.noEmail) log("[Option: NO-EMAIL enabled]");

  const now = new Date();

  // If dry-run mode:
  if (options.dryRun) {
    const userWhere = options.userId ? { id: options.userId } : { weeklyDigestEnabled: true };
    const users = await prisma.user.findMany({
      where: userWhere,
      select: { id: true, name: true, codename: true, email: true },
    });

    log(`Found ${users.length} candidate user(s) for preview.`);

    const startDate = new Date(now.getTime() - SEVEN_DAYS_MS);

    for (const u of users) {
      log(`\n--- Digest Preview for User: ${u.codename || u.name || u.email || u.id} ---`);
      const metrics = await calculateDigestMetricsForUser(u.id, startDate, now);
      const textPreview = renderDigestText(
        {
          startDate,
          endDate: now,
          newFindingsCount: metrics.newFindingsCount,
          dismissedFindingsCount: metrics.dismissedFindingsCount,
          resolvedFindingsCount: metrics.resolvedFindingsCount,
          blockedPrsCount: metrics.blockedPrsCount,
          topRepositories: metrics.topRepositories,
          topFindingTypes: metrics.topFindingTypes,
        },
        u,
      );
      log(textPreview);
    }

    return { success: true, generated: users.length, skipped: 0, errors: 0 };
  }

  // Active generation:
  const mailTransport = options.noEmail ? new MockMailTransport() : undefined;

  if (options.userId) {
    log(`Generating digest for single user: ${options.userId}`);
    const res = await generateWeeklyDigestForUser(options.userId, {
      now,
      force: options.force,
      mailTransport,
    });

    if (res.success) {
      log(
        `Digest generated successfully for user ${options.userId}. Email sent: ${res.emailSent ? "YES" : "NO"}`,
      );
      return { success: true, generated: 1, skipped: 0, errors: 0 };
    } else if (res.skipped) {
      log(`Digest skipped for user ${options.userId}: ${res.reason}`);
      return { success: true, generated: 0, skipped: 1, errors: 0 };
    } else {
      console.error(`Error generating digest for user ${options.userId}:`, res.error);
      return { success: false, generated: 0, skipped: 0, errors: 1 };
    }
  }

  log("Starting batch weekly digest run for all users...");
  const batchRes = await generateAllWeeklyDigests({
    now,
    force: options.force,
    mailTransport,
  });

  log(`Batch run completed:`);
  log(`  Total Users Checked : ${batchRes.totalUsers}`);
  log(`  Digests Generated   : ${batchRes.generated}`);
  log(`  Digests Skipped     : ${batchRes.skipped}`);
  log(`  Errors              : ${batchRes.errors.length}`);

  if (batchRes.errors.length > 0) {
    for (const err of batchRes.errors) {
      console.error(`  [User ${err.userId}]: ${err.error}`);
    }
  }

  return {
    success: batchRes.errors.length === 0,
    generated: batchRes.generated,
    skipped: batchRes.skipped,
    errors: batchRes.errors.length,
  };
}

// Execute when invoked directly from CLI
if (process.env.NODE_ENV !== "test" && typeof require !== "undefined" && require.main === module) {
  runWeeklyDigestCli()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Fatal error during weekly digest run:", err);
      process.exit(1);
    });
}
