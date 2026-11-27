#!/usr/bin/env node
import fs from "fs";
import path from "path";
import {
  GitError,
  getStagedFiles,
  readStagedContent,
  getChangedFilesSince,
  getStagedDiffLineNumbers,
  getRepoRoot,
  isGitRepository,
} from "./git.js";
import { installHook, uninstallHook, printHookHelp } from "./hook.js";
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
  generateVoiceSummaryText,
  countFindingsBySeverity,
  formatSeverityCounts,
  type FailOnSeverity,
  DEFAULT_IGNORE_PATTERNS,
  compileIgnorePatterns,
  type FileScanResult,
  type OutputFormat,
  type Severity,
} from "./scanner.js";
import { loadCustomRulesFromConfig, type CompiledCustomRule } from "./custom-rules.js";
import {
  NetworkUnavailableError,
  requestAiFileScan,
  submitSbomScan,
  pollSbomScanStatus,
  requestWeb3Explanation,
  type AiFinding,
  type StagedFileForAiScan,
} from "./lib/api-client.js";
import { hostedAiScanSkipReason, localModeEnv, validateCliAiConfig } from "./lib/local-mode.js";
import {
  CliUsageError,
  parseVerbosityArg,
  parseQuietArg,
  parseVerboseArg,
  type VerbosityLevel,
  parseIgnoreFilePath,
  parseConfigFilePath,
  parseOutputFormat,
  parseOutputPath,
  parseVoiceArg,
  parseSinceArg,
  parseNoCacheArg,
  parseCacheClearArg,
  parseCachePruneArg,
  parseCacheStatsArg,
  parseCacheTtlArg,
  parseCacheMaxSizeArg,
  parseCacheDirArg,
  parseIgnoreSuppressionsArg,
  parseTargetDirectoryArg,
  parseStagedArg,
  parseBaselineArg,
  parseWatchArg,
} from "./lib/output-args.js";
import {
  DEFAULT_BASELINE_FILENAME,
  loadBaseline,
  saveBaseline,
  createBaselineFromResults,
  updateBaselineWithResults,
  filterResultsWithBaseline,
} from "./baseline.js";
import { discoverWorkspaceFiles } from "./workspace.js";
import {
  getCacheEntry,
  setCacheEntry,
  clearCache,
  pruneCache,
  getCacheStats,
  parseDurationMs,
  parseSizeBytes,
} from "./cache.js";
import { playVoiceDebrief } from "./lib/audio-player.js";
import {
  TerminalSpinner,
  ScanProgressIndicator,
  formatTuiScanSummary,
  initSecureFlow,
  formatInitGreeting,
} from "./lib/tui.js";
import { runWatchMode } from "./watch.js";

let VERBOSE = process.argv.includes("--verbose");
let QUIET = process.argv.includes("--quiet") || process.argv.includes("-q");
if (VERBOSE && QUIET) {
  VERBOSE = false;
  QUIET = false;
}
const DRY_RUN = process.argv.includes("--dry-run");
const AI_SKIP_REASON = hostedAiScanSkipReason(process.argv);

Object.assign(process.env, localModeEnv(process.argv, process.env));

if (typeof validateCliAiConfig === "function") {
  try {
    const cliAiConfig = validateCliAiConfig(process.argv, process.env);
    if (VERBOSE) {
      const baseInfo = cliAiConfig.baseUrl ? `, baseUrl=${cliAiConfig.baseUrl}` : "";
      console.log(
        `ℹ️  [SecureFlow] Active AI model: provider=${cliAiConfig.provider}, model=${cliAiConfig.model}${baseInfo}`,
      );
    }
  } catch (err: any) {
    console.error(`❌ [SecureFlow] Configuration Error: ${err.message}`);
    process.exit(1);
  }
}

function printMcpHelp(): void {
  console.log(`
SecureFlow CLI - Threat Intelligence MCP Server

Usage:
  secureflow mcp [options]

Description:
  Start the SecureFlow Threat Intelligence Model Context Protocol (MCP) server over stdio.
  Communicates using JSON-RPC protocol over standard input/output with automatic
  heartbeat liveness monitoring and graceful broken pipe / EOF recovery.

Options:
  -h, --help                     Show this help message
  --heartbeat-interval=<ms>      Interval between client liveness ping checks (default: 30000ms, 0 to disable)
  --heartbeat-timeout=<ms>       Timeout waiting for client pong response (default: 10000ms)
  --stall-timeout=<ms>           Timeout for stdio stream inactivity / stall detection (default: 60000ms, 0 to disable)
`);
}

function parseMcpOptions(argv: string[]) {
  const options: {
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    stallTimeoutMs?: number;
  } = {};

  for (const arg of argv) {
    if (arg.startsWith("--heartbeat-interval=")) {
      const val = Number.parseInt(arg.slice("--heartbeat-interval=".length), 10);
      if (!Number.isNaN(val) && val >= 0) options.heartbeatIntervalMs = val;
    } else if (arg.startsWith("--heartbeat-timeout=")) {
      const val = Number.parseInt(arg.slice("--heartbeat-timeout=".length), 10);
      if (!Number.isNaN(val) && val >= 0) options.heartbeatTimeoutMs = val;
    } else if (arg.startsWith("--stall-timeout=")) {
      const val = Number.parseInt(arg.slice("--stall-timeout=".length), 10);
      if (!Number.isNaN(val) && val >= 0) options.stallTimeoutMs = val;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
SecureFlow CLI - Security analysis tool for staged git files

Usage:
  secureflow [path] [options]
  secureflow scan [path] [options]
  secureflow scan --staged [options]
  secureflow watch [path] [options]
  secureflow hook install [options]
  secureflow hook uninstall [options]
  secureflow validate [file] [options]
  secureflow doctor [options]
  secureflow mcp [options]
  secureflow sbom <file> [options]
  secureflow explain --web3 [options]

Commands:
  scan                   Scan workspace or staged files for security violations
  watch [path]           Watch workspace for file changes and rescan continuously
  hook install           Install Git pre-commit hook to block commits with staged secrets (#2020)
  hook uninstall         Uninstall Git pre-commit hook and restore previous hook backup (#2020)
  validate [file]        Validate .secureflow.json and .secureflowignore against schema with line-numbered error reports
  doctor                 Diagnose environment variables, DB/Redis connectivity, migrations, LLM keys, and GitHub App setup
  mcp                    Start the SecureFlow Threat Intelligence Model Context Protocol (MCP) server over stdio
  sbom <file>            Scan software bill of materials (manifests: package.json, requirements.txt, etc.)
  explain --web3         Generate AI security analysis and remediation for Web3 / Smart Contract findings
  cache-clear            Clear the local scan cache directory (.secureflow/cache)
  cache-prune            Prune expired (TTL) and excess (max size) entries from cache
  cache-stats            Display diagnostic storage statistics and telemetry for scan cache
  baseline create [file] Create or overwrite a findings baseline file (.secureflow-baseline.json) (#2060)
  baseline update [file] Update baseline with current scan results (removes fixed, records new) (#2060)

Options:
  -w, --watch            Watch workspace for file changes and rescan continuously
  --baseline [file]      Path to baseline file to suppress legacy findings (default: .secureflow-baseline.json)
  --staged               Scan only the staged diff (blocks commits on secrets at configured severity)
  --init                 Initialize SecureFlow (interactive wizard for git hooks, .secureflow.json, and .secureflowignore)
  --validate [file]      Validate configuration files against schema
  --force, -f            Overwrite existing configuration files without confirmation
  --severity <level>     Minimum blocking severity threshold for init or fail-on
  --ignore <paths>       Paths to ignore for init (comma-separated globs)
  --languages <langs>    Languages in repository for init (comma-separated)
  --husky                Initialize using Husky pre-commit hook (.husky/pre-commit)
  --blank                Initialize using Blank mode (package.json prepare script)
  --since <ref>          Scan only files changed versus specified git ref (e.g. --since origin/main)
  --dir <path>           Recursively scan workspace directory
  --no-cache             Disable scan caching and force fresh analysis on all files
  --cache-dir <path>     Specify custom local cache directory
  --cache-ttl <duration> Max time-to-live for cache entries (e.g. 7d, 30d, 24h)
  --cache-max-size <sz>  Maximum cache directory storage ceiling (e.g. 50MB, 100M)
  -q, --quiet            Print only the summary and errors
  --verbose              Enable verbose logging (per-file timing and skipped files)
  --format <format>      Output format: text, json, sarif, csv, html, markdown, junit (default: text)
  -o, --output <path>    Write output to specified file path
  --ignore-file <path>   Path to custom ignore configuration file
  --config <path>, -c    Path to custom configuration file (.secureflow.json)
  --fail-on <level>      Fail scan threshold (critical, high, medium, low, none)
  --local                Run scan locally without uploading files externally
  --local-model <tag>    Specify local AI model tag (default: llama3)
  --dry-run              Simulate scan execution without writing files
  --file <path>          Target file for explain subcommand
  --finding-type <type>  Vulnerability type identifier for explain subcommand
  --poll                 Poll until SBOM scan completion (for sbom command)
  -v, --voice            Play an audio summary debrief of scan findings upon completion
  --color                Force colored output even on non-TTY terminals
  --no-color             Disable colored output
  -h, --help             Show this help message
`);
}

function parseSeverityArg(): Set<Severity> | null {
  const idx = process.argv.findIndex(
    (arg) => arg === "--severity" || arg.startsWith("--severity="),
  );
  if (idx === -1) return null;

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

function reportFileTiming(filePath: string, durationMs: number, cached = false): void {
  if (VERBOSE) {
    const timingStr = durationMs < 1 ? `${durationMs.toFixed(2)}ms` : `${durationMs.toFixed(1)}ms`;
    const cachedStr = cached ? ", cached" : "";
    console.log(`  ✓ scanned ${filePath} (${timingStr}${cachedStr})`);
  }
}

function reportViolations(result: FileScanResult): void {
  for (const violation of result.violations) {
    if (violation.custom || (violation.ruleId && violation.ruleId !== "console-secret-logging")) {
      console.error(
        `🚨 [SecureFlow] [Custom Rule: ${violation.ruleId || "custom"}] Violation detected in ${result.path}:${violation.line}`,
      );
      console.error(`  -> ${violation.text}`);
      console.error(`  why: ${violation.reason}`);
    } else {
      console.error(`🚨 [SecureFlow] Secret logging detected in ${result.path}:${violation.line}`);
      console.error(`  -> ${violation.text}`);
      console.error(`  why: ${violation.reason} passed to a console call`);
    }
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

async function runAiScanIfAvailable(stagedForAi: StagedFileForAiScan[]): Promise<AiFinding[]> {
  const isStagedMode = process.argv.includes("--staged");
  if (isStagedMode) {
    if (VERBOSE) {
      console.log(
        "ℹ️  [SecureFlow] Pre-commit staged mode: running deterministic local scan without network.",
      );
    }
    return [];
  }
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
  if (parseCacheClearArg(process.argv)) {
    let customCacheDir: string | undefined;
    try {
      customCacheDir = parseCacheDirArg(process.argv);
    } catch (err: any) {
      console.error(`❌ [SecureFlow] ${err.message}`);
      return 1;
    }
    const repoRoot = getRepoRoot();
    const result = clearCache(customCacheDir, repoRoot);
    if (result.cleared) {
      console.log(
        `🧹 [SecureFlow] Cache cleared successfully (${result.count} entr${result.count === 1 ? "y" : "ies"} removed).`,
      );
      return 0;
    } else {
      console.error(`❌ [SecureFlow] Failed to clear cache directory at ${result.cacheDir}`);
      return 1;
    }
  }

  if (parseCachePruneArg(process.argv)) {
    let customCacheDir: string | undefined;
    let ttlMs: number | undefined;
    let maxSizeBytes: number | undefined;
    try {
      customCacheDir = parseCacheDirArg(process.argv);
      const ttlStr = parseCacheTtlArg(process.argv);
      if (ttlStr !== undefined) {
        const parsedTtl = parseDurationMs(ttlStr);
        if (parsedTtl === null) {
          throw new CliUsageError(
            `Invalid TTL duration "${ttlStr}". Examples: 7d, 24h, 30m, 3600s`,
          );
        }
        ttlMs = parsedTtl;
      }
      const maxSizeStr = parseCacheMaxSizeArg(process.argv);
      if (maxSizeStr !== undefined) {
        const parsedSize = parseSizeBytes(maxSizeStr);
        if (parsedSize === null) {
          throw new CliUsageError(
            `Invalid max cache size "${maxSizeStr}". Examples: 50MB, 100M, 1GB`,
          );
        }
        maxSizeBytes = parsedSize;
      }
    } catch (err: any) {
      console.error(`❌ [SecureFlow] ${err.message}`);
      return 1;
    }
    const repoRoot = getRepoRoot();
    const result = pruneCache({ ttlMs, maxSizeBytes, cacheDir: customCacheDir, cwd: repoRoot });
    const freedFormatted =
      result.freedBytes < 1024
        ? `${result.freedBytes} B`
        : result.freedBytes < 1024 * 1024
          ? `${(result.freedBytes / 1024).toFixed(1)} KB`
          : `${(result.freedBytes / (1024 * 1024)).toFixed(2)} MB`;
    console.log(
      `🧹 [SecureFlow] Cache pruned: ${result.prunedCount} entr${result.prunedCount === 1 ? "y" : "ies"} removed (${freedFormatted} freed), ${result.remainingCount} remaining.`,
    );
    return 0;
  }

  if (parseCacheStatsArg(process.argv)) {
    let customCacheDir: string | undefined;
    try {
      customCacheDir = parseCacheDirArg(process.argv);
    } catch (err: any) {
      console.error(`❌ [SecureFlow] ${err.message}`);
      return 1;
    }
    const repoRoot = getRepoRoot();
    const stats = getCacheStats(customCacheDir, repoRoot);

    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(stats, null, 2));
      return 0;
    }

    const sizeFormatted =
      stats.totalSizeBytes < 1024
        ? `${stats.totalSizeBytes} B`
        : stats.totalSizeBytes < 1024 * 1024
          ? `${(stats.totalSizeBytes / 1024).toFixed(1)} KB`
          : `${(stats.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`;

    console.log(`\n📦 [SecureFlow] Scan Cache Statistics`);
    console.log(`─────────────────────────────────────────────`);
    console.log(`Location:          ${stats.cacheDir}`);
    console.log(`Total Entries:     ${stats.entryCount}`);
    console.log(`Disk Storage:      ${sizeFormatted}`);
    console.log(`Orphaned Temp:     ${stats.tempFileCount} files`);
    console.log(
      `Oldest Entry:      ${stats.oldestEntryAt ? new Date(stats.oldestEntryAt).toISOString() : "None"}`,
    );
    console.log(
      `Newest Entry:      ${stats.newestEntryAt ? new Date(stats.newestEntryAt).toISOString() : "None"}`,
    );
    const versions = Object.entries(stats.rulesetVersions);
    if (versions.length > 0) {
      console.log(
        `Ruleset Versions:  ${versions.map(([v, count]) => `v${v} (${count})`).join(", ")}`,
      );
    }
    console.log(`─────────────────────────────────────────────\n`);
    return 0;
  }

  if (process.argv[2] === "hook") {
    const action = process.argv[3];
    if (action === "install") {
      const force =
        process.argv.includes("--force") ||
        process.argv.includes("-f") ||
        process.argv.includes("-y") ||
        process.argv.includes("--yes");
      const dryRun = process.argv.includes("--dry-run");
      const result = await installHook({ force, dryRun });
      if (result.success) {
        console.log(result.message);
        return 0;
      } else {
        console.error(result.message);
        return 1;
      }
    } else if (action === "uninstall") {
      const dryRun = process.argv.includes("--dry-run");
      const result = await uninstallHook({ dryRun });
      if (result.success) {
        console.log(result.message);
        return 0;
      } else {
        console.error(result.message);
        return 1;
      }
    } else if (action === "--help" || action === "-h" || !action) {
      printHookHelp();
      return 0;
    } else {
      console.error(
        `❌ [SecureFlow] Unknown hook command "${action}". Supported commands: install, uninstall.`,
      );
      return 1;
    }
  }

  const isValidateCommand =
    process.argv[2] === "validate" ||
    process.argv.includes("--validate") ||
    process.argv.some((arg) => arg.startsWith("--validate="));

  if (isValidateCommand) {
    let targetPath: string | undefined;
    if (process.argv[2] === "validate") {
      const candidate = process.argv[3];
      if (candidate && !candidate.startsWith("-")) {
        targetPath = candidate;
      }
    } else {
      const idx = process.argv.findIndex((a) => a === "--validate" || a.startsWith("--validate="));
      if (idx !== -1) {
        const arg = process.argv[idx]!;
        if (arg.startsWith("--validate=")) {
          targetPath = arg.slice("--validate=".length);
        } else if (idx + 1 < process.argv.length && !process.argv[idx + 1]!.startsWith("-")) {
          targetPath = process.argv[idx + 1];
        }
      }
    }

    const { validateConfigFiles } = await import("./init-config.js");
    const report = validateConfigFiles({
      filePath: targetPath,
      targetDir: process.cwd(),
    });

    if (report.valid) {
      console.log("✅ [SecureFlow] Configuration validation passed.");
      for (const [file, res] of Object.entries(report.files)) {
        if (res.exists) {
          console.log(`   ✓ ${file} is valid`);
        }
      }
      return 0;
    } else {
      console.error(
        `❌ [SecureFlow] Configuration validation failed with ${report.allErrors.length} error(s):`,
      );
      for (const err of report.allErrors) {
        const colStr = err.column ? `:${err.column}` : "";
        console.error(`   ${err.file}:${err.line}${colStr} - ${err.message}`);
      }
      return 1;
    }
  }

  const isInitCommand =
    process.argv[2] === "init" ||
    process.argv.some(
      (arg) =>
        arg === "--init" || arg.startsWith("--init=") || arg === "--husky" || arg === "--blank",
    );

  if (isInitCommand) {
    const result = await initSecureFlow();
    const greeting = formatInitGreeting(result);
    if (result.success) {
      console.log(greeting);
      return 0;
    } else {
      console.error(greeting);
      return 1;
    }
  }

  if (process.argv[2] === "doctor" || process.argv.includes("--doctor")) {
    const { runDiagnostics, formatDoctorReport, printDoctorHelp } = await import("./doctor.js");
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      printDoctorHelp();
      return 0;
    }
    const report = await runDiagnostics({ argv: process.argv });
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    return report.success ? 0 : 1;
  }

  const isMcpCommand = process.argv[2] === "mcp";

  if (isMcpCommand) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      printMcpHelp();
      return 0;
    }

    try {
      const { startMcpServer } = await import("./mcp/index.js");
      const mcpOptions = parseMcpOptions(process.argv);
      const session = await startMcpServer(mcpOptions);
      if (session && typeof session.waitForClose === "function") {
        await session.waitForClose();
      }
      return 0;
    } catch (err) {
      console.error(
        `❌ [SecureFlow MCP] Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  if (process.argv[2] === "sbom") {
    const filePath = process.argv[3];
    if (!filePath || filePath.startsWith("-")) {
      console.error(
        "❌ [SecureFlow SBOM] Please specify a manifest file (e.g. secureflow sbom package.json)",
      );
      return 1;
    }

    if (!fs.existsSync(filePath)) {
      console.error(`❌ [SecureFlow SBOM] File not found: ${filePath}`);
      return 1;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const shouldPoll = process.argv.includes("--poll");

    try {
      console.log(
        `📦 [SecureFlow SBOM] Submitting ${fileName} for dependency vulnerability scan...`,
      );
      const submission = await submitSbomScan(fileName, content);
      console.log(
        `✅ [SecureFlow SBOM] Scan enqueued successfully! Job ID: ${submission.jobId} (status: ${submission.status})`,
      );

      if (shouldPoll) {
        console.log(`⏳ [SecureFlow SBOM] Polling status for job ${submission.jobId}...`);
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          const statusRes = await pollSbomScanStatus(submission.jobId);
          if (statusRes.status === "COMPLETED") {
            const summary = statusRes.result?.summary;
            console.log(`\n🎉 [SecureFlow SBOM] Scan Complete!`);
            if (summary) {
              console.log(`   Total Dependencies: ${summary.totalDependencies}`);
              console.log(`   Vulnerable: ${summary.vulnerableDependencies}`);
              console.log(
                `   Critical: ${summary.criticalCount} | High: ${summary.highCount} | Medium: ${summary.mediumCount} | Low: ${summary.lowCount}`,
              );
            }
            return 0;
          } else if (statusRes.status === "FAILED") {
            console.error(`❌ [SecureFlow SBOM] Job failed: ${statusRes.error || "Unknown error"}`);
            return 1;
          }
          attempts++;
        }
        console.log(
          `ℹ️  [SecureFlow SBOM] Scan is still processing. Check status with: /api/sbom/scan/status/${submission.jobId}`,
        );
      }
      return 0;
    } catch (err) {
      console.error(`❌ [SecureFlow SBOM] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (
    process.argv[2] === "explain" ||
    (process.argv.includes("explain") && process.argv.includes("--web3"))
  ) {
    const fileArgIdx = process.argv.indexOf("--file");
    const targetFile =
      fileArgIdx !== -1 && process.argv[fileArgIdx + 1] ? process.argv[fileArgIdx + 1] : undefined;
    const findingTypeIdx = process.argv.indexOf("--finding-type");
    const findingType =
      findingTypeIdx !== -1 && process.argv[findingTypeIdx + 1]
        ? process.argv[findingTypeIdx + 1]!
        : "Reentrancy Vulnerability";
    const severityIdx = process.argv.indexOf("--severity");
    const severityVal =
      severityIdx !== -1 && process.argv[severityIdx + 1]
        ? (process.argv[severityIdx + 1]!.toUpperCase() as any)
        : "HIGH";

    let codeSnippet = "";
    if (targetFile && fs.existsSync(targetFile)) {
      codeSnippet = fs.readFileSync(targetFile, "utf-8");
    } else {
      codeSnippet =
        '// Example contract snippet\nfunction withdraw() external {\n  (bool s, ) = msg.sender.call{value: bal}("");\n  bal = 0;\n}';
    }

    console.log(`🧠 [SecureFlow Web3] Generating smart contract security explanation...`);
    try {
      const explanation = await requestWeb3Explanation({
        findingType,
        severity: severityVal || "HIGH",
        description: `Potential Web3 flaw identified in ${targetFile || "contract"}.`,
        fileLocation: targetFile || "Contract.sol",
        codeSnippet,
      });

      console.log(`\n🛡️ [Ecosystem: ${explanation.ecosystem || "solidity"}]`);
      console.log(`📝 Explanation:\n   ${explanation.explanation}\n`);
      console.log(`🔧 Remediation Recommendations:`);
      explanation.remediationSuggestions.forEach((sug, i) => {
        console.log(`   ${i + 1}. ${sug}`);
      });
      return 0;
    } catch (err) {
      console.error(`❌ [SecureFlow Web3] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (process.argv[2] === "baseline") {
    const action = process.argv[3];
    if (action === "--help" || action === "-h" || !action) {
      console.log(`
SecureFlow CLI - Findings Baseline Management (#2060)

Usage:
  secureflow baseline create [path]
  secureflow baseline update [path]

Description:
  Manage findings baseline files (.secureflow-baseline.json) to suppress legacy
  violations and only block commits on newly introduced security issues.
`);
      return 0;
    }

    let targetBaselinePath = DEFAULT_BASELINE_FILENAME;
    if (process.argv[4] && !process.argv[4].startsWith("-")) {
      targetBaselinePath = process.argv[4];
    }

    if (action === "create" || action === "update") {
      const repoRoot = getRepoRoot();
      const files = discoverWorkspaceFiles(".", { workspaceRoot: repoRoot });
      const customIgnores = compileIgnorePatterns([...DEFAULT_IGNORE_PATTERNS]);
      const scanResults: FileScanResult[] = [];

      for (const file of files) {
        const resolved = repoRoot ? path.resolve(repoRoot, file) : file;
        try {
          if (fs.existsSync(resolved)) {
            const content = fs.readFileSync(resolved, "utf-8");
            const result = scanFile(file, content, customIgnores);
            if (result.violations.length > 0) {
              scanResults.push(result);
            }
          }
        } catch {
          // ignore unreadable
        }
      }

      if (action === "create") {
        const baseline = createBaselineFromResults(scanResults);
        const saved = saveBaseline(baseline, targetBaselinePath, repoRoot);
        console.log(
          `✅ [SecureFlow] Created baseline file at ${saved} (${baseline.violations.length} violation(s) recorded).`,
        );
        return 0;
      } else {
        const existing = loadBaseline(targetBaselinePath, repoRoot);
        const { updatedBaseline, addedCount, removedCount } = updateBaselineWithResults(
          existing,
          scanResults,
        );
        const saved = saveBaseline(updatedBaseline, targetBaselinePath, repoRoot);
        console.log(
          `✅ [SecureFlow] Updated baseline file at ${saved} (+${addedCount} added, -${removedCount} removed, ${updatedBaseline.violations.length} total).`,
        );
        return 0;
      }
    } else {
      console.error(
        `❌ [SecureFlow] Unknown baseline action "${action}". Expected "create" or "update".`,
      );
      return 1;
    }
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return 0;
  }

  let format: OutputFormat;
  let outputPath: string | null;
  let customIgnorePath: string | undefined;
  let customConfigPath: string | undefined;
  let sinceRef: string | undefined;
  let noCache = false;
  let customCacheDir: string | undefined;
  let failOnThreshold: FailOnSeverity | null = null;
  const ignoreSuppressions = parseIgnoreSuppressionsArg(process.argv);

  try {
    const verbosity = parseVerbosityArg(process.argv);
    VERBOSE = verbosity === "verbose";
    QUIET = verbosity === "quiet";
    format = parseOutputFormat(process.argv);
    outputPath = parseOutputPath(process.argv);
    customIgnorePath = parseIgnoreFilePath(process.argv);
    customConfigPath = parseConfigFilePath(process.argv);
    sinceRef = parseSinceArg(process.argv);
    noCache = parseNoCacheArg(process.argv);
    customCacheDir = parseCacheDirArg(process.argv);
    failOnThreshold = parseFailOnArg(process.argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    console.error(`❌ [SecureFlow] ${error.message}`);
    return 1;
  }

  const hasFailOnFlag = process.argv.some(
    (arg) => arg === "--fail-on" || arg.startsWith("--fail-on="),
  );
  const voiceEnabled = parseVoiceArg(process.argv);
  const severityFilter = parseSeverityArg();
  const targetDir = parseTargetDirectoryArg(process.argv);
  const baselinePathArg = parseBaselineArg(process.argv);
  const repoInGit = isGitRepository();
  const isSinceMode = sinceRef !== undefined;
  const isStagedMode = parseStagedArg(process.argv);
  const isDirMode = targetDir !== undefined || (!isSinceMode && !isStagedMode && !repoInGit);

  if (isStagedMode && !repoInGit) {
    console.error("❌ [SecureFlow] Not a git repository (or git is not on PATH).");
    return hasFailOnFlag ? 2 : 1;
  }

  const repoRoot = getRepoRoot();
  const loadedBaseline =
    baselinePathArg !== undefined ? loadBaseline(baselinePathArg, repoRoot) : null;
  if (baselinePathArg !== undefined && !loadedBaseline && VERBOSE) {
    console.warn(
      `⚠️  [SecureFlow] Baseline file "${baselinePathArg}" not found. No findings suppressed.`,
    );
  }
  let baselineSuppressedCount = 0;
  const ignoreData = loadSecureFlowIgnore(customIgnorePath, repoRoot);
  const customIgnores = compileIgnorePatterns([
    ...DEFAULT_IGNORE_PATTERNS,
    ...(ignoreData ? ignoreData.config.ignoredPaths : []),
  ]);

  const customRulesResult = loadCustomRulesFromConfig({
    configPath: customConfigPath,
    targetDir,
    repoRoot,
  });

  if (customRulesResult.errors.length > 0) {
    console.error(
      `❌ [SecureFlow] Configuration Error: Invalid custom rule configuration${
        customRulesResult.configPath ? ` in '${customRulesResult.configPath}'` : ""
      }:`,
    );
    for (const err of customRulesResult.errors) {
      console.error(`  -> ${err}`);
    }
    return 1;
  }

  const customRules = customRulesResult.rules;
  if (VERBOSE && customRules.length > 0) {
    console.log(
      `ℹ️  [SecureFlow] Loaded ${customRules.length} custom security rule(s) from ${customRulesResult.configPath}`,
    );
  }

  const isWatchMode = parseWatchArg(process.argv);
  if (isWatchMode) {
    return await runWatchMode({
      targetDir: targetDir ?? ".",
      workspaceRoot: repoRoot ?? process.cwd(),
      customIgnores,
      customRules,
      severityFilter,
      failOnThreshold,
      ignoreSuppressions,
    });
  }

  let filesToScan: string[] = [];

  try {
    if (targetDir !== undefined) {
      filesToScan = discoverWorkspaceFiles(targetDir, {
        workspaceRoot: repoRoot,
        customIgnores,
      });
    } else if (sinceRef !== undefined) {
      filesToScan = getChangedFilesSince(sinceRef);
    } else if (isStagedMode || repoInGit) {
      filesToScan = getStagedFiles();
    } else {
      filesToScan = discoverWorkspaceFiles(".", {
        workspaceRoot: repoRoot,
        customIgnores,
      });
    }
  } catch (error) {
    console.error(`❌ [SecureFlow] ${error instanceof GitError ? error.message : String(error)}`);
    return hasFailOnFlag ? 2 : 1;
  }

  const fileResults: FileScanResult[] = [];
  const unreadable: string[] = [];
  const stagedForAi: StagedFileForAiScan[] = [];
  const cachedAiFindings: AiFinding[] = [];
  const newlyAnalyzed: Array<{ filePath: string; content: string; result: FileScanResult }> = [];
  let analyzedCount = 0;
  let cachedCount = 0;
  let skippedCount = 0;

  if (VERBOSE && ignoreData) {
    console.log(
      `ℹ️  [SecureFlow] Loaded ${ignoreData.config.ignoredPaths.length} ignore pattern(s) from ignore configuration`,
    );
  }

  let violationCount = 0;

  const progress = new ScanProgressIndicator(filesToScan.length, {
    quiet: QUIET,
    ...(format !== "text" ? { enabled: false } : {}),
  });

  if (filesToScan.length > 0) {
    for (let i = 0; i < filesToScan.length; i++) {
      const filePath = filesToScan[i]!;
      progress.update(i + 1, filePath);
      const startFileTime = performance.now();
      let content: string | null = null;

      if (isDirMode || isSinceMode) {
        try {
          const resolvedPath = repoRoot ? path.resolve(repoRoot, filePath) : filePath;
          if (fs.existsSync(resolvedPath)) {
            content = fs.readFileSync(resolvedPath, "utf-8");
          } else {
            content = readStagedContent(filePath);
          }
        } catch {
          content = null;
        }
      } else {
        content = readStagedContent(filePath);
      }

      if (content === null) {
        unreadable.push(filePath);
        continue;
      }

      const cached = !noCache
        ? getCacheEntry({ filePath, content, cacheDir: customCacheDir })
        : null;

      if (cached) {
        cachedCount++;
        const elapsedMs = performance.now() - startFileTime;
        const result: FileScanResult = {
          ...cached.result,
          path: filePath,
        };
        if (isStagedMode) {
          const diffLines = getStagedDiffLineNumbers(filePath, repoRoot);
          if (diffLines && diffLines.size > 0) {
            result.violations = result.violations.filter((v) => diffLines.has(v.line));
          }
        }
        let effectiveResult = result;
        if (loadedBaseline) {
          const filtered = filterResultsWithBaseline([result], loadedBaseline);
          effectiveResult = filtered.results[0]!;
          baselineSuppressedCount += filtered.suppressedCount;
        }
        fileResults.push(effectiveResult);
        if (effectiveResult.skipped) {
          skippedCount++;
        }
        if (cached.aiFindings && cached.aiFindings.length > 0) {
          cachedAiFindings.push(
            ...cached.aiFindings.map((f) => ({ ...f, fileLocation: filePath })),
          );
        }
        if (format === "text") {
          if (VERBOSE) {
            progress.clear();
            if (effectiveResult.skipped) {
              reportSkipped(effectiveResult);
            } else {
              reportFileTiming(filePath, elapsedMs, true);
            }
          }
          if (effectiveResult.violations.length > 0) {
            progress.clear();
            reportViolations(effectiveResult);
          }
        }
        violationCount += effectiveResult.violations.length;
      } else {
        analyzedCount++;
        const rawResult = scanFile(filePath, content, customIgnores, {
          ...(ignoreSuppressions ? { ignoreSuppressions } : {}),
          ...(customRules.length > 0 ? { customRules } : {}),
        });
        let diffResult = rawResult;
        if (isStagedMode) {
          const diffLines = getStagedDiffLineNumbers(filePath, repoRoot);
          if (diffLines && diffLines.size > 0) {
            diffResult = {
              ...rawResult,
              violations: rawResult.violations.filter((v) => diffLines.has(v.line)),
            };
          }
        }
        const elapsedMs = performance.now() - startFileTime;
        // The cache is keyed by file content only, so it must keep the unfiltered result.
        newlyAnalyzed.push({ filePath, content, result: rawResult });

        let effectiveResult = diffResult;
        if (loadedBaseline) {
          const filtered = filterResultsWithBaseline([diffResult], loadedBaseline);
          effectiveResult = filtered.results[0]!;
          baselineSuppressedCount += filtered.suppressedCount;
        }

        fileResults.push(effectiveResult);
        if (effectiveResult.skipped) {
          skippedCount++;
        }
        if (format === "text") {
          if (VERBOSE) {
            progress.clear();
            if (effectiveResult.skipped) {
              reportSkipped(effectiveResult);
            } else {
              reportFileTiming(filePath, elapsedMs, false);
            }
          }
          if (effectiveResult.violations.length > 0) {
            progress.clear();
            reportViolations(effectiveResult);
          }
        }
        violationCount += effectiveResult.violations.length;

        if (!effectiveResult.skipped) {
          stagedForAi.push({ path: filePath, content });
        }
      }
    }
    progress.done();
  }

  if (!QUIET && baselineSuppressedCount > 0) {
    console.log(
      `ℹ️  [SecureFlow] Baseline suppressed ${baselineSuppressedCount} legacy violation(s) from ${baselinePathArg}.`,
    );
  }

  const filteredResults = severityFilter
    ? filterBySeverity(fileResults, severityFilter)
    : fileResults;

  const aiSpinner =
    format === "text" && stagedForAi.length > 0 && !QUIET
      ? new TerminalSpinner("Running AI security inspection").start()
      : null;
  const aiFindings = await runAiScanIfAvailable(stagedForAi);
  if (aiSpinner) {
    aiSpinner.succeed(
      `AI inspection completed (${aiFindings.length} finding${aiFindings.length === 1 ? "" : "s"})`,
    );
  }

  if (!noCache && newlyAnalyzed.length > 0) {
    for (const item of newlyAnalyzed) {
      const fileAiFindings = aiFindings.filter((f) => f.fileLocation === item.filePath);
      setCacheEntry({
        filePath: item.filePath,
        content: item.content,
        result: item.result,
        aiFindings: fileAiFindings,
        cacheDir: customCacheDir,
      });
    }
  }

  const allAiFindings = [...cachedAiFindings, ...aiFindings];
  const filteredAiFindings = severityFilter
    ? allAiFindings.filter((f) => severityFilter.has(f.severity))
    : allAiFindings;
  if (format === "text") {
    for (const finding of filteredAiFindings) {
      reportAiFinding(finding);
    }
    if (!QUIET && (fileResults.length > 0 || filteredAiFindings.length > 0)) {
      console.log(formatTuiScanSummary(filteredResults, filteredAiFindings));
    }
    if (!QUIET && filesToScan.length > 0) {
      console.log(`ℹ️  [SecureFlow] Analyzed ${analyzedCount} file(s) (${cachedCount} cached).`);
      if (VERBOSE) {
        console.log(`ℹ️  [SecureFlow] Skipped ${skippedCount} file(s) (ignored or excluded).`);
      }
    }
  }
  if (
    format === "sarif" ||
    format === "json" ||
    format === "csv" ||
    format === "html" ||
    format === "markdown" ||
    format === "junit"
  ) {
    const outputString =
      format === "sarif"
        ? formatScanResults(filteredResults, "sarif", { aiFindings: filteredAiFindings })
        : format === "junit"
          ? formatScanResults(filteredResults, "junit", {
              failOnThreshold,
              aiFindings: filteredAiFindings,
            })
          : formatScanResults(filteredResults, format);
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

  if (unreadable.length > 0) {
    const entryLabel = isSinceMode ? "changed" : "staged";
    console.warn(
      `⚠️  [SecureFlow] Could not read ${unreadable.length} ${entryLabel} entr${
        unreadable.length === 1 ? "y" : "ies"
      } (submodule, symlink or conflicted): ${unreadable.join(", ")}`,
    );
  }

  let configBlockOn: FailOnSeverity | null = null;
  const configPath =
    customConfigPath || (repoRoot ? path.join(repoRoot, ".secureflow.json") : ".secureflow.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const blockOn = parsedConfig?.gate?.blockOn;
      if (typeof blockOn === "string") {
        const upper = blockOn.toUpperCase();
        if (
          upper === "CRITICAL" ||
          upper === "HIGH" ||
          upper === "MEDIUM" ||
          upper === "LOW" ||
          upper === "NONE"
        ) {
          configBlockOn = upper as FailOnSeverity;
        }
      }
    } catch {
      // Ignored here
    }
  }

  const activeThreshold = failOnThreshold ?? configBlockOn ?? parseFailOnArg();
  const allLocalViolations = fileResults.flatMap((r) => r.violations);
  const normalizedViolations = allLocalViolations.map((v) =>
    v.severity !== undefined ? { severity: v.severity } : {},
  );
  const shouldFail = allLocalViolations.some((v) => v.custom)
    ? shouldFailScan(normalizedViolations, allAiFindings, activeThreshold)
    : shouldFailScan(violationCount, allAiFindings, activeThreshold);
  const blockingAi = blockingAiFindings(allAiFindings, activeThreshold);

  if (format === "text") {
    const counts = allLocalViolations.some((v) => v.custom)
      ? countFindingsBySeverity(normalizedViolations, allAiFindings)
      : countFindingsBySeverity(violationCount, allAiFindings);
    console.log(formatSeverityCounts(counts));
  }

  if (voiceEnabled && !QUIET) {
    const summaryText = generateVoiceSummaryText(violationCount, allAiFindings, !shouldFail);
    await playVoiceDebrief(summaryText, {
      files: stagedForAi,
      verbose: VERBOSE,
    });
  }

  if (shouldFail) {
    if (format === "text") {
      const parts: string[] = [];
      const secretViolations = allLocalViolations.filter((v) => !v.custom);
      const customViolations = allLocalViolations.filter((v) => v.custom);

      if (secretViolations.length > 0) {
        parts.push(
          `${secretViolations.length} secret-logging violation${secretViolations.length === 1 ? "" : "s"}`,
        );
      }
      if (customViolations.length > 0) {
        parts.push(
          `${customViolations.length} custom-rule violation${customViolations.length === 1 ? "" : "s"}`,
        );
      }
      if (blockingAi.length > 0) {
        parts.push(`${blockingAi.length} AI-detected finding${blockingAi.length === 1 ? "" : "s"}`);
      }
      const subject = parts.length > 0 ? parts.join(" and ") : "findings";
      console.error(
        `\n❌ SecureFlow blocked this commit: ${subject} at or above ${describeFailThreshold(
          activeThreshold,
        )}. Remove the exposed secrets/env variables, then re-stage.`,
      );
    }
    return 1;
  }

  if (format === "text") {
    const advisoryCount = violationCount + allAiFindings.length;
    if (advisoryCount > 0) {
      console.log(
        `⚠️  SecureFlow advisory warning: ${advisoryCount} finding${
          advisoryCount === 1 ? "" : "s"
        } below ${describeFailThreshold(activeThreshold)}. Scan passing.`,
      );
    } else {
      const modeLabel = isDirMode
        ? `file(s) in ${targetDir ?? "directory"}`
        : isSinceMode
          ? `changed file(s) since ${sinceRef}`
          : "staged file(s)";
      console.log(`✅ SecureFlow scan passed (${filesToScan.length} ${modeLabel}).`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      `❌ [SecureFlow] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
    const hasFailOn = process.argv.some((a) => a === "--fail-on" || a.startsWith("--fail-on="));
    process.exit(hasFailOn ? 2 : 1);
  });
