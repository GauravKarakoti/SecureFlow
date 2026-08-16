/**
 * Data-retention CLI.
 *
 *   npm run retention                    # dry run — reports, writes nothing
 *   npm run retention -- --apply         # actually purge
 *   npm run retention -- --only=auditLog # one target
 *   npm run retention -- --batch-size=200
 *
 * Dry run is the default on purpose. This deletes production data; opting into
 * that should be an explicit act, not the consequence of forgetting a flag.
 *
 * Exits non-zero when any target fails, so a scheduler notices.
 */

import prisma from '../src/lib/prisma';
import { runRetention, formatReport, type PurgeOptions } from '../src/lib/retention/purge';
import { RETENTION_RULES, RetentionConfigError, type PurgeTarget } from '../src/lib/retention/policy';

const VALID_TARGETS = RETENTION_RULES.map((rule) => rule.target);

function usage(): string {
  const targets = VALID_TARGETS.join(', ');
  return [
    'Usage: npm run retention [-- options]',
    '',
    'Options:',
    '  --apply                Perform the purge. Without this, runs as a dry run.',
    '  --dry-run              Explicitly request a dry run (the default).',
    `  --only=<target>        Restrict to one target. Repeatable. One of: ${targets}`,
    '  --batch-size=<n>       Rows per statement (default 500).',
    '  --help                 Show this message.',
    '',
    'Retention windows are read from the environment:',
    ...RETENTION_RULES.map(
      (rule) => `  ${rule.envVar.padEnd(30)} default ${rule.defaultDays}d`
    ),
  ].join('\n');
}

export function parseArgs(argv: string[]): PurgeOptions & { help: boolean } {
  const options: PurgeOptions & { help: boolean } = { dryRun: true, help: false };
  const only: PurgeTarget[] = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--apply') {
      options.dryRun = false;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length).trim();
      if (!VALID_TARGETS.includes(value as PurgeTarget)) {
        throw new Error(`Unknown --only target "${value}". Expected one of: ${VALID_TARGETS.join(', ')}`);
      }
      only.push(value as PurgeTarget);
      continue;
    }

    if (arg.startsWith('--batch-size=')) {
      const value = Number(arg.slice('--batch-size='.length).trim());
      if (!Number.isInteger(value) || value < 1 || value > 10_000) {
        throw new Error(`--batch-size must be a whole number between 1 and 10000, got "${arg}".`);
      }
      options.batchSize = value;
      continue;
    }

    // An unrecognised flag is an error rather than a no-op: silently ignoring
    // a typo'd `--aply` on a destructive command is how data gets kept, or lost,
    // by accident.
    throw new Error(`Unrecognised argument "${arg}".\n\n${usage()}`);
  }

  if (only.length > 0) options.only = only;

  return options;
}

async function main(): Promise<number> {
  let options: PurgeOptions & { help: boolean };

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  try {
    const report = await runRetention(prisma as never, options);
    console.log(formatReport(report));

    if (report.dryRun && report.totalAffected > 0) {
      console.log('\nRe-run with --apply to perform the purge.');
    }

    return report.hadErrors ? 1 : 0;
  } catch (error) {
    if (error instanceof RetentionConfigError) {
      // A misconfigured window is an operator error, not a crash — say so
      // plainly rather than printing a stack trace.
      console.error(`Retention configuration error: ${error.message}`);
      return 2;
    }

    console.error('Retention run failed:', error instanceof Error ? error.message : error);
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
