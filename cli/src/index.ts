#!/usr/bin/env node
/**
 * SecureFlow pre-commit hook.
 *
 * The shell only: read the staged set, scan each blob, report, exit. The
 * detection logic lives in `./scanner` and the git access in `./git`, so both
 * can be tested without a process exit or a repository (#593).
 */
import { GitError, getStagedFiles, readStagedContent } from './git.js';
import { scanFile, type FileScanResult } from './scanner.js';

const VERBOSE = process.argv.includes('--verbose');

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

export function formatFinding(finding: {
  type: string;
  severity: string;
  file: string;
  line?: number;
}): string {
  const loc = finding.line ? `:${finding.line}` : '';
  return `[${finding.severity}] ${finding.type} — ${finding.file}${loc}`;
}

function reportSkipped(result: FileScanResult): void {
  if (VERBOSE && result.skipped) {
    console.log(`   ↷ skipped ${result.path} (${result.skipped})`);
  }
}

function reportViolations(result: FileScanResult): void {
  for (const violation of result.violations) {
    console.error(`🚨 [SecureFlow] Secret logging detected in ${result.path}:${violation.line}`);
    console.error(`   -> ${violation.text}`);
    console.error(`   why: ${violation.reason} passed to a console call`);
  }
}

function main(): number {
  let staged: string[];

  try {
    staged = getStagedFiles();
  } catch (error) {
    // Distinguished rather than collapsed into "Are you in a git repository?",
    // which was previously printed for a buffer overflow, a missing git binary
    // and a genuine non-repository alike.
    console.error(`❌ [SecureFlow] ${error instanceof GitError ? error.message : String(error)}`);
    return 1;
  }

  if (staged.length === 0) {
    console.log('✅ SecureFlow scan passed (nothing staged).');
    return 0;
  }

  const unreadable: string[] = [];
  let violationCount = 0;

  for (const path of staged) {
    // The staged blob, not the working-tree file. This is the whole fix: the
    // hook now checks the content that is about to be committed rather than
    // whatever happens to be on disk when it runs.
    const content = readStagedContent(path);

    if (content === null) {
      unreadable.push(path);
      continue;
    }

    const result = scanFile(path, content);
    reportSkipped(result);
    reportViolations(result);
    violationCount += result.violations.length;
  }

  if (unreadable.length > 0) {
    // Named rather than silently passed. A file we could not read is a file we
    // did not check, and saying so is the difference between a gap and a lie.
    console.warn(
      `⚠️  [SecureFlow] Could not read ${unreadable.length} staged entr${
        unreadable.length === 1 ? 'y' : 'ies'
      } (submodule, symlink or conflicted): ${unreadable.join(', ')}`,
    );
  }

  if (violationCount > 0) {
    console.error(
      `\n❌ SecureFlow blocked this commit: ${violationCount} secret-logging violation${
        violationCount === 1 ? '' : 's'
      }. Remove the exposed secrets/env variables, then re-stage.`,
    );
    return 1;
  }

  console.log(`✅ SecureFlow scan passed (${staged.length} staged file(s)).`);
  return 0;
}

// Only run when executed directly, not when imported by tests.
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) process.exit(main());
