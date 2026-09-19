#!/usr/bin/env node
import fs from "fs";
import { GitError, getStagedFiles, readStagedContent } from "./git.js";
import { scanFile, formatScanResults, type FileScanResult, type OutputFormat } from "./scanner.js";
import {
  NetworkUnavailableError,
  requestAiFileScan,
  type AiFinding,
  type StagedFileForAiScan,
} from "./lib/api-client.js";
import { hostedAiScanSkipReason } from "./lib/local-mode.js";

const VERBOSE = process.argv.includes("--verbose");
const AI_SKIP_REASON = hostedAiScanSkipReason(process.argv);

/**
 * --local flag: keep staged code on this machine (#892).
 *
 * The hosted AI pass is skipped (see hostedAiScanSkipReason), because it
 * uploads file contents to the SecureFlow API whatever LOCAL_AI_URL says.
 * LOCAL_AI_URL / LOCAL_AI_MODEL are still set for any in-process AI module
 * that reads them via resolveLocalModelConfig().
 * The model can be overridden with --local-model <tag> (default: llama3).
 */
const LOCAL_FLAG = process.argv.includes("--local");
if (LOCAL_FLAG) {
  const localFlagIndex = process.argv.findIndex((a) => a === "--local");
  const nextArg = process.argv[localFlagIndex + 1];

  // Check if the argument after --local is a URL (starts with http:// or https://)
  const customUrl =
    nextArg && (nextArg.startsWith("http://") || nextArg.startsWith("https://"))
      ? nextArg
      : undefined;

  const modelIdx = process.argv.findIndex((a) => a === "--local-model");
  const localModel = modelIdx !== -1 ? process.argv[modelIdx + 1] : undefined;

  process.env.LOCAL_AI_URL = customUrl || process.env.LOCAL_AI_URL || "http://localhost:11434/v1";
  if (localModel) process.env.LOCAL_AI_MODEL = localModel;
}

function parseFormatArg(): OutputFormat {
  const formatIndex = process.argv.findIndex((arg) => arg === "--format");
  if (formatIndex !== -1) {
    const valStr = process.argv[formatIndex + 1];
    if (valStr) {
      const val = valStr.toLowerCase();
      if (
        val === "sarif" ||
        val === "json" ||
        val === "text" ||
        val === "csv" ||
        val === "html" ||
        val === "markdown"
      ) {
        return val as OutputFormat;
      }
      if (val === "md") {
        return "markdown";
      }
    }
  }
  return "text";
}

function parseOutputArg(): string | null {
  const outIndex = process.argv.findIndex((arg) => arg === "-o" || arg === "--output");
  if (outIndex !== -1) {
    const valStr = process.argv[outIndex + 1];
    if (valStr) {
      return valStr;
    }
  }
  return null;
}

function reportSkipped(result: FileScanResult): void {
  if (VERBOSE && result.skipped) {
    console.log(`  ↷ skipped ${result.path} (${result.skipped})`);
  }
}

function reportViolations(result: FileScanResult): void {
  for (const violation of result.violations) {
    console.error(`🚨 [SecureFlow] Secret logging detected in ${result.path}:${violation.line}`);
    console.error(`  -> ${violation.text}`);
    console.error(`  why: ${violation.reason} passed to a console call`);
  }
}

function reportAiFinding(finding: AiFinding): void {
  console.error(
    `🤖 [SecureFlow AI] ${finding.severity} ${finding.type} in ${finding.fileLocation}${
      finding.lineStart ? `:${finding.lineStart}` : ""
    }`,
  );
  console.error(`  -> ${finding.description}`);
}

/**
 * Best-effort AI-powered scan on top of the always-on local scan above.
 * Never throws and never delays the commit beyond its own short internal
 * timeout -- if the network is down, this is a silent (or
 * --verbose-logged) no-op and the local scan result stands on its own,
 * unchanged.
 */
async function runAiScanIfAvailable(stagedForAi: StagedFileForAiScan[]): Promise<AiFinding[]> {
  if (AI_SKIP_REASON === "local" && VERBOSE) {
    console.warn(
      "ℹ️  [SecureFlow] --local: hosted AI scan skipped, staged code stays on this machine.",
    );
  }
  if (AI_SKIP_REASON || stagedForAi.length === 0) return [];

  try {
    return await requestAiFileScan(stagedForAi);
  } catch (err) {
    if (err instanceof NetworkUnavailableError) {
      if (VERBOSE) {
        console.warn("⚠️  [SecureFlow] AI scan unreachable -- continuing with local scan only.");
      }
      return [];
    }
    throw err;
  }
}

async function main(): Promise<number> {
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
  const stagedForAi: StagedFileForAiScan[] = [];
  let violationCount = 0;

  if (staged.length > 0) {
    for (const path of staged) {
      const content = readStagedContent(path);

      if (content === null) {
        unreadable.push(path);
        continue;
      }

      stagedForAi.push({ path, content });

      const result = scanFile(path, content);
      fileResults.push(result);
      if (format === "text") {
        reportSkipped(result);
        reportViolations(result);
      }
      violationCount += result.violations.length;
    }
  }

  // AI-powered pass, additive on top of the local scan above. Only
  // affects the text output/exit code today -- JSON/SARIF export stays
  // local-scan-only for now so existing automated consumers of those
  // formats aren't changed by this PR.
  const aiFindings = await runAiScanIfAvailable(stagedForAi);
  if (format === "text") {
    for (const finding of aiFindings) {
      reportAiFinding(finding);
    }
  }
  const aiViolationCount = aiFindings.filter(
    (f) => f.severity === "HIGH" || f.severity === "CRITICAL",
  ).length;

  if (
    format === "sarif" ||
    format === "json" ||
    format === "csv" ||
    format === "html" ||
    format === "markdown"
  ) {
    const outputString = formatScanResults(fileResults, format);
    if (outputPath) {
      fs.writeFileSync(outputPath, outputString, "utf-8");
      console.log(
        `📄 [SecureFlow] Scan report exported in ${format.toUpperCase()} format to ${outputPath}`,
      );
    } else {
      console.log(outputString);
    }
  } else if (outputPath) {
    const textOutput = formatScanResults(fileResults, "text");
    fs.writeFileSync(outputPath, textOutput, "utf-8");
    console.log(`📄 [SecureFlow] Scan report written to ${outputPath}`);
  }

  if (unreadable.length > 0 && format === "text") {
    console.warn(
      `⚠️  [SecureFlow] Could not read ${unreadable.length} staged entr${
        unreadable.length === 1 ? "y" : "ies"
      } (submodule, symlink or conflicted): ${unreadable.join(", ")}`,
    );
  }

  if (violationCount > 0 || aiViolationCount > 0) {
    if (format === "text") {
      console.error(
        `\n❌ SecureFlow blocked this commit: ${violationCount} secret-logging violation${
          violationCount === 1 ? "" : "s"
        }${
          aiViolationCount > 0
            ? ` and ${aiViolationCount} AI-detected HIGH/CRITICAL finding${aiViolationCount === 1 ? "" : "s"}`
            : ""
        }. Remove the exposed secrets/env variables, then re-stage.`,
      );
    }
    return 1;
  }

  if (format === "text") {
    console.log(`✅ SecureFlow scan passed (${staged.length} staged file(s)).`);
  }
  return 0;
}

main().then((code) => process.exit(code));
