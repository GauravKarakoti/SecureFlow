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
  type FileScanResult,
  type OutputFormat,
} from "./scanner.js";
import {
  NetworkUnavailableError,
  requestAiFileScan,
  type AiFinding,
  type StagedFileForAiScan,
} from "./lib/api-client.js";
import { hostedAiScanSkipReason } from "./lib/local-mode.js";

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
const LOCAL_FLAG = process.argv.includes("--local");
const OLLAMA_FLAG = process.argv.some((a) => a === "--ollama" || a.startsWith("--ollama="));
const VLLM_FLAG = process.argv.some((a) => a === "--vllm" || a.startsWith("--vllm="));

if (LOCAL_FLAG || OLLAMA_FLAG || VLLM_FLAG) {
  let customUrl: string | undefined;
  let customModel: string | undefined;
  let provider: string | undefined;

  if (OLLAMA_FLAG) {
    provider = "ollama";
    const ollamaArg = process.argv.find((a) => a.startsWith("--ollama="));
    if (ollamaArg) {
      customUrl = ollamaArg.split("=")[1];
    } else {
      const idx = process.argv.findIndex((a) => a === "--ollama");
      const next = process.argv[idx + 1];
      if (next && (next.startsWith("http://") || next.startsWith("https://"))) {
        customUrl = next;
      }
    }
    const modelIdx = process.argv.findIndex((a) => a === "--ollama-model");
    if (modelIdx !== -1) customModel = process.argv[modelIdx + 1];
  } else if (VLLM_FLAG) {
    provider = "vllm";
    const vllmArg = process.argv.find((a) => a.startsWith("--vllm="));
    if (vllmArg) {
      customUrl = vllmArg.split("=")[1];
    } else {
      const idx = process.argv.findIndex((a) => a === "--vllm");
      const next = process.argv[idx + 1];
      if (next && (next.startsWith("http://") || next.startsWith("https://"))) {
        customUrl = next;
      }
    }
    const modelIdx = process.argv.findIndex((a) => a === "--vllm-model");
    if (modelIdx !== -1) customModel = process.argv[modelIdx + 1];
  } else if (LOCAL_FLAG) {
    const localFlagIndex = process.argv.findIndex((a) => a === "--local");
    const nextArg = process.argv[localFlagIndex + 1];
    customUrl =
      nextArg && (nextArg.startsWith("http://") || nextArg.startsWith("https://"))
        ? nextArg
        : undefined;
  }

  const genericModelIdx = process.argv.findIndex((a) => a === "--local-model");
  if (genericModelIdx !== -1) customModel = process.argv[genericModelIdx + 1];

  if (provider) process.env.LOCAL_AI_PROVIDER = provider;
  const defaultUrl = provider === "vllm" ? "http://localhost:8000/v1" : "http://localhost:11434/v1";
  process.env.LOCAL_AI_URL = customUrl || process.env.LOCAL_AI_URL || defaultUrl;
  if (customModel) process.env.LOCAL_AI_MODEL = customModel;
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

function parseIgnoreFileArg(): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === "--ignore-file" || arg === "--ignore");
  if (idx !== -1) {
    const val = process.argv[idx + 1];
    if (val && !val.startsWith("-")) {
      return val;
    }
  }
  for (const arg of process.argv) {
    if (arg.startsWith("--ignore-file=")) {
      return arg.split("=")[1];
    }
  }
  return undefined;
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

  const customIgnorePath = parseIgnoreFileArg();
  const ignoreData = loadSecureFlowIgnore(customIgnorePath);
  const customIgnores = ignoreData?.compiledPatterns ?? [];

  if (VERBOSE && ignoreData) {
    console.log(
      `ℹ️  [SecureFlow] Loaded ${ignoreData.config.ignoredPaths.length} ignore pattern(s) from ignore configuration`,
    );
  }

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
  if (
    format === "sarif" ||
    format === "json" ||
    format === "csv" ||
    format === "html" ||
    format === "markdown"
  ) {
    const outputString = formatScanResults(fileResults, format);
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
    const textOutput = formatScanResults(fileResults, "text");
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
  const shouldFail = shouldFailScan(violationCount, aiFindings, failOnThreshold);
  // Which AI findings actually cleared the active bar — not just the
  // HIGH/CRITICAL ones the old count was limited to. Under
  // `--fail-on=LOW` a single LOW finding blocks the commit, and the message has
  // to name it rather than reporting "0 violations".
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
