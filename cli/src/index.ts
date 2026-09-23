#!/usr/bin/env node
import fs from "fs";
import { GitError, getStagedFiles, readStagedContent } from "./git.js";
import {
  scanFile,
  formatScanResults,
  parseFailOnArg,
  shouldFailScan,
  loadSecureFlowIgnore,
  blockingAiFindings,
  describeFailThreshold,
  filterBySeverity,
  parseSeverityFilter,
  type FileScanResult,
  type OutputFormat,
  type Severity,
} from "./scanner.js";
import {
  NetworkUnavailableError,
  requestAiFileScan,
  type AiFinding,
  type StagedFileForAiScan,
} from "./lib/api-client.js";
import { hostedAiScanSkipReason, localModeEnv } from "./lib/local-mode.js";
import {
  CliUsageError,
  parseIgnoreFilePath,
  parseOutputFormat,
  parseOutputPath,
} from "./lib/output-args.js";

const VERBOSE = process.argv.includes("--verbose");
const DRY_RUN = process.argv.includes("--dry-run");
const AI_SKIP_REASON = hostedAiScanSkipReason(process.argv);

/**
 * --local / --ollama / --vllm flags: keep staged code on this machine (#892).
 *
 * The hosted AI pass is skipped (see hostedAiScanSkipReason), because it
 * uploads file contents to the SecureFlow API whatever LOCAL_AI_URL says.
 * LOCAL_AI_URL / LOCAL_AI_MODEL / LOCAL_AI_PROVIDER are still set for any in-process AI module
 * that reads them via resolveLocalModelConfig().
 * The model can be overridden with --local-model <tag>, --ollama-model <tag>, or --vllm-model <tag>.
 */
Object.assign(process.env, localModeEnv(process.argv, process.env));

function printHelp(): void {
  console.log(`
SecureFlow CLI - Security analysis tool for staged git files

Usage:
  secureflow [options]

Options:
  --verbose              Enable verbose logging
  --format <format>      Output format: text, json, sarif, csv, html, markdown (default: text)
  -o, --output <path>    Write output to specified file path
  --ignore-file <path>   Path to custom ignore configuration file
  --fail-on <level>      Fail scan threshold (low, medium, high, critical)
  --local                Run scan locally without uploading files externally
  --local-model <tag>    Specify local AI model tag (default: llama3)
  --dry-run              Simulate scan execution without writing files
  -h, --help             Show this help message

Examples:
  $ secureflow                                     # Run standard security scan on staged files
  $ secureflow --format json -o res.json           # Scan and export results to JSON file
  $ secureflow --fail-on high                      # Fail commit only on high/critical findings
  $ secureflow --local --local-model llama3        # Run completely local scan
`);
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

function parseSeverityArg(): Set<Severity> | null {
  const idx = process.argv.findIndex(
    (arg) => arg === "--severity" || arg.startsWith("--severity="),
  );
  if (idx === -1) return null;
  // (baaki ka parsing logic jo main branch mein hai wahi rahega)
}

  const arg = process.argv[idx]!;
  const valStr = arg.startsWith("--severity=")
    ? arg.slice("--severity=".length)
    : process.argv[idx + 1];
  if (!valStr) {
    console.error(
      "❌ [SecureFlow] --severity requires a comma-separated list (e.g. --severity high,critical)",
    );
    process.exit(1);
  }

  try {
    return parseSeverityFilter(valStr);
  } catch (err) {
    console.error(`❌ [SecureFlow] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
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
if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return 0;
  }

  let format: OutputFormat;
  let outputPath: string | null;
  let customIgnorePath: string | undefined;
  try {
    format = parseOutputFormat(process.argv);
    outputPath = parseOutputPath(process.argv);
    customIgnorePath = parseIgnoreFilePath(process.argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    console.error(`❌ [SecureFlow] ${error.message}`);
    return 1;
  }
  const severityFilter = parseSeverityArg();
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

  const ignoreData = loadSecureFlowIgnore(customIgnorePath);
  const customIgnores = ignoreData?.compiledPatterns ?? [];

  if (VERBOSE && ignoreData) {
    console.log(
      `ℹ️  [SecureFlow] Loaded ${ignoreData.config.ignoredPaths.length} ignore pattern(s) from ignore configuration`,
    );
  }

  let violationCount = 0;

  if (staged.length > 0) {
    for (const path of staged) {
      const content = readStagedContent(path);

      if (content === null) {
        unreadable.push(path);
        continue;
      }

      const result = scanFile(path, content, customIgnores);
      fileResults.push(result);
      if (format === "text") {
        reportSkipped(result);
        reportViolations(result);
      }
      violationCount += result.violations.length;

      if (!result.skipped) {
        stagedForAi.push({ path, content });
      }
    }
  }

  const filteredResults = severityFilter
    ? filterBySeverity(fileResults, severityFilter)
    : fileResults;

  // AI-powered pass, additive on top of the local scan above. Only
  // affects the text output/exit code today -- JSON/SARIF export stays
  // local-scan-only for now so existing automated consumers of those
  // formats aren't changed by this PR.
  const aiFindings = await runAiScanIfAvailable(stagedForAi);
  const filteredAiFindings = severityFilter
    ? aiFindings.filter((f) => severityFilter.has(f.severity))
    : aiFindings;
  if (format === "text") {
    for (const finding of filteredAiFindings) {
      reportAiFinding(finding);
    }
  }
  if (
    format === "sarif" ||
    format === "json" ||
    format === "csv" ||
    format === "html" ||
    format === "markdown"
  ) {
    const outputString = formatScanResults(filteredResults, format);
    if (outputPath) {
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would write to ${outputPath}:
${outputString}`);
      } else {
        fs.writeFileSync(outputPath, outputString, "utf-8");
      }
      console.log(
        `📄 [SecureFlow] Scan report exported in ${format.toUpperCase()} format to ${outputPath}`,
      );
    } else {
      console.log(outputString);
    }
  } else if (outputPath) {
    const textOutput = formatScanResults(filteredResults, "text");
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would write to ${outputPath}:
${textOutput}`);
    } else {
      fs.writeFileSync(outputPath, textOutput, "utf-8");
    }
    console.log(`📄 [SecureFlow] Scan report written to ${outputPath}`);
  }

  if (unreadable.length > 0 && format === "text") {
    console.warn(
      `⚠️  [SecureFlow] Could not read ${unreadable.length} staged entr${
        unreadable.length === 1 ? "y" : "ies"
      } (submodule, symlink or conflicted): ${unreadable.join(", ")}`,
    );
  }

  const failOnThreshold = parseFailOnArg();
  // Exit-code decision uses UNFILTERED aiFindings: --severity is a display
  // filter, not a security gate bypass. --fail-on must see every finding.
  const shouldFail = shouldFailScan(violationCount, aiFindings, failOnThreshold);
  const blockingAi = blockingAiFindings(aiFindings, failOnThreshold);

  if (shouldFail) {
    if (format === "text") {
      const parts: string[] = [];
      if (violationCount > 0) {
        parts.push(`${violationCount} secret-logging violation${violationCount === 1 ? "" : "s"}`);
      }
      if (blockingAi.length > 0) {
        parts.push(`${blockingAi.length} AI-detected finding${blockingAi.length === 1 ? "" : "s"}`);
      }
      const subject = parts.length > 0 ? parts.join(" and ") : "findings";
      console.error(
        `\n❌ SecureFlow blocked this commit: ${subject} at or above ${describeFailThreshold(
          failOnThreshold,
        )}. Remove the exposed secrets/env variables, then re-stage.`,
      );
    }
    return 1;
  }

  if (format === "text") {
    const advisoryCount = violationCount + aiFindings.length;
    if (advisoryCount > 0) {
      console.log(
        `⚠️  SecureFlow advisory warning: ${advisoryCount} finding${
          advisoryCount === 1 ? "" : "s"
        } below ${describeFailThreshold(failOnThreshold)}. Scan passing.`,
      );
    } else {
      console.log(`✅ SecureFlow scan passed (${staged.length} staged file(s)).`);
    }
  }
  return 0;
}

main().then((code) => process.exit(code));
