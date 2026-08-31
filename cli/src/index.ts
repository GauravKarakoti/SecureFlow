#!/usr/bin/env node
import fs from 'fs';
import { GitError, getStagedFiles, readStagedContent } from './git.js';
import { scanFile, formatScanResults, type FileScanResult, type OutputFormat } from './scanner.js';
import { formatSarifJson } from './sarif.js';

const VERBOSE = process.argv.includes('--verbose');

function parseFormatArg(): OutputFormat {
  const formatIndex = process.argv.findIndex((arg) => arg === '--format');
  if (formatIndex !== -1 && process.argv[formatIndex + 1]) {
    const val = process.argv[formatIndex + 1].toLowerCase();
    if (val === 'sarif' || val === 'json' || val === 'text') {
      return val as OutputFormat;
    }
  }
  return 'text';
}

function parseOutputArg(): string | null {
  const outIndex = process.argv.findIndex((arg) => arg === '-o' || arg === '--output');
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    return process.argv[outIndex + 1];
  }
  return null;
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
  const format = parseFormatArg();
  const outputPath = parseOutputArg();
  let staged: string[];

  try {
    staged = getStagedFiles();
  } catch (error) {
    console.error(`❌ [SecureFlow] ${error instanceof GitError ? error.message : String(error)}`);
    return 1;
  }

  const fileResults: FileScanResult[] = [];
  const unreadable: string[] = [];
  let violationCount = 0;

  if (staged.length > 0) {
    for (const path of staged) {
      const content = readStagedContent(path);

      if (content === null) {
        unreadable.push(path);
        continue;
      }

      const result = scanFile(path, content);
      fileResults.push(result);
      if (format === 'text') {
        reportSkipped(result);
        reportViolations(result);
      }
      violationCount += result.violations.length;
    }
  }

  if (format === 'sarif' || format === 'json') {
    const outputString = formatScanResults(fileResults, format);
    if (outputPath) {
      fs.writeFileSync(outputPath, outputString, 'utf-8');
      console.log(`📄 [SecureFlow] Scan report exported in ${format.toUpperCase()} format to ${outputPath}`);
    } else {
      console.log(outputString);
    }
  } else if (outputPath) {
    const textOutput = formatScanResults(fileResults, 'text');
    fs.writeFileSync(outputPath, textOutput, 'utf-8');
    console.log(`📄 [SecureFlow] Scan report written to ${outputPath}`);
  }

  if (unreadable.length > 0 && format === 'text') {
    console.warn(
      `⚠️  [SecureFlow] Could not read ${unreadable.length} staged entr${
        unreadable.length === 1 ? 'y' : 'ies'
      } (submodule, symlink or conflicted): ${unreadable.join(', ')}`,
    );
  }

  if (violationCount > 0) {
    if (format === 'text') {
      console.error(
        `\n❌ SecureFlow blocked this commit: ${violationCount} secret-logging violation${
          violationCount === 1 ? '' : 's'
        }. Remove the exposed secrets/env variables, then re-stage.`,
      );
    }
    return 1;
  }

  if (format === 'text') {
    console.log(`✅ SecureFlow scan passed (${staged.length} staged file(s)).`);
  }
  return 0;
}

process.exit(main());

