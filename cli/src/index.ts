#!/usr/bin/env node
import fs from "fs";
import path from "path";
import {
  GitError,
  getStagedFiles,
  readStagedContent,
  getChangedFilesSince,
  getRepoRoot,
} from "./git.js";
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
  type FileScanResult,
  type OutputFormat,
  type Severity,
} from "./scanner.js";
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
  parseIgnoreFilePath,
  parseOutputFormat,
  parseOutputPath,
  parseVoiceArg,
  parseSinceArg,
  parseNoCacheArg,
  parseCacheClearArg,
  parseCacheDirArg,
} from "./lib/output-args.js";
import { getCacheEntry, setCacheEntry, clearCache } from "./cache.js";
import { playVoiceDebrief } from "./lib/audio-player.js";
import {
  TerminalSpinner,
  formatTuiScanSummary,
  initSecureFlow,
  formatInitGreeting,
} from "./lib/tui.js";

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
  secureflow [options]
  secureflow scan [options]
  secureflow validate [file] [options]
  secureflow mcp [options]
  secureflow sbom <file> [options]
  secureflow explain --web3 [options]

Commands:
  validate [file]        Validate .secureflow.json and .secureflowignore against schema with line-numbered error reports
  mcp                    Start the SecureFlow Threat Intelligence Model Context Protocol (MCP) server over stdio
  sbom <file>            Scan software bill of materials (manifests: package.json, requirements.txt, etc.)
  explain --web3         Generate AI security analysis and remediation for Web3 / Smart Contract findings
  cache-clear            Clear the local scan cache directory (.secureflow/cache)

Options:
  --init                 Initialize SecureFlow (interactive wizard for git hooks, .secureflow.json, and .secureflowignore)
  --validate [file]      Validate configuration files against schema
  --force, -f            Overwrite existing configuration files without confirmation
  --severity <level>     Minimum blocking severity threshold for init or fail-on
  --ignore <paths>       Paths to ignore for init (comma-separated globs)
  --languages <langs>    Languages in repository for init (comma-separated)
  --husky                Initialize using Husky pre-commit hook (.husky/pre-commit)
  --blank                Initialize using Blank mode (package.json prepare script)
  --since <ref>          Scan only files changed versus specified git ref (e.g. --since origin/main)
  --no-cache             Disable scan caching and force fresh analysis on all files
  --cache-dir <path>     Specify custom local cache directory
  --verbose              Enable verbose logging
  --format <format>      Output format: text, json, sarif, csv, html, markdown (default: text)
  -o, --output <path>    Write output to specified file path
  --ignore-file <path>   Path to custom ignore configuration file
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

Examples:
  $ secureflow --init                              # Initialize configuration (.secureflow.json, .secureflowignore) and git hooks
  $ secureflow --init --severity HIGH --force      # Non-interactive initialization with severity threshold
  $ secureflow validate                            # Validate .secureflow.json and .secureflowignore
  $ secureflow validate .secureflow.json           # Validate specific configuration file
  $ secureflow                                     # Run standard security scan on staged files
  $ secureflow --since origin/main                 # Scan only files changed versus origin/main
  $ secureflow --no-cache                          # Force fresh scan without reading/writing cache
  $ secureflow cache-clear                         # Clear the local scan results cache
  $ secureflow sbom package.json                   # Enqueue an SBOM dependency scan
  $ secureflow sbom requirements.txt --poll        # Enqueue and poll until SBOM results arrive
  $ secureflow explain --web3 --file Token.sol     # Get Web3 audit explanation for a smart contract
  $ secureflow -v                                  # Run scan and play audio summary debrief
  $ secureflow mcp                                 # Start the Threat Intelligence MCP server over stdio
  $ secureflow --format json -o res.json           # Scan and export results to JSON file
  $ secureflow --fail-on high                      # Fail commit only on high/critical findings
  $ secureflow --local --local-model llama3        # Run completely local scan
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

  // Handle `secureflow sbom <file>` command (#1589)
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

  // Handle `secureflow explain --web3` command (#1589)
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

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return 0;
  }

  let format: OutputFormat;
  let outputPath: string | null;
  let customIgnorePath: string | undefined;
  let sinceRef: string | undefined;
  let noCache = false;
  let customCacheDir: string | undefined;
  let failOnThreshold: FailOnSeverity | null = null;
  try {
    format = parseOutputFormat(process.argv);
    outputPath = parseOutputPath(process.argv);
    customIgnorePath = parseIgnoreFilePath(process.argv);
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
  const isSinceMode = sinceRef !== undefined;
  let filesToScan: string[];

  try {
    if (sinceRef !== undefined) {
      filesToScan = getChangedFilesSince(sinceRef);
    } else {
      filesToScan = getStagedFiles();
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

  const ignoreData = loadSecureFlowIgnore(customIgnorePath);
  const customIgnores = ignoreData?.compiledPatterns ?? [];

  if (VERBOSE && ignoreData) {
    console.log(
      `ℹ️  [SecureFlow] Loaded ${ignoreData.config.ignoredPaths.length} ignore pattern(s) from ignore configuration`,
    );
  }

  let violationCount = 0;

  if (filesToScan.length > 0) {
    const repoRoot = isSinceMode ? getRepoRoot() : undefined;

    for (const filePath of filesToScan) {
      let content: string | null = null;

      if (isSinceMode) {
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

      // Check cache unless --no-cache was specified
      const cached = !noCache
        ? getCacheEntry({ filePath, content, cacheDir: customCacheDir })
        : null;

      if (cached) {
        cachedCount++;
        const result: FileScanResult = {
          ...cached.result,
          path: filePath,
        };
        fileResults.push(result);
        if (cached.aiFindings && cached.aiFindings.length > 0) {
          cachedAiFindings.push(
            ...cached.aiFindings.map((f) => ({ ...f, fileLocation: filePath })),
          );
        }
        if (format === "text") {
          reportSkipped(result);
          reportViolations(result);
        }
        violationCount += result.violations.length;
      } else {
        analyzedCount++;
        const result = scanFile(filePath, content, customIgnores);
        fileResults.push(result);
        newlyAnalyzed.push({ filePath, content, result });
        if (format === "text") {
          reportSkipped(result);
          reportViolations(result);
        }
        violationCount += result.violations.length;

        if (!result.skipped) {
          stagedForAi.push({ path: filePath, content });
        }
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
  const aiSpinner =
    format === "text" && stagedForAi.length > 0
      ? new TerminalSpinner("Running AI security inspection").start()
      : null;
  const aiFindings = await runAiScanIfAvailable(stagedForAi);
  if (aiSpinner) {
    aiSpinner.succeed(
      `AI inspection completed (${aiFindings.length} finding${aiFindings.length === 1 ? "" : "s"})`,
    );
  }

  // Persist newly analyzed results to cache
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
    if (fileResults.length > 0 || filteredAiFindings.length > 0) {
      console.log(formatTuiScanSummary(filteredResults, filteredAiFindings));
    }
    if (filesToScan.length > 0) {
      console.log(`ℹ️  [SecureFlow] Analyzed ${analyzedCount} file(s) (${cachedCount} cached).`);
    }
  }
  if (
    format === "sarif" ||
    format === "json" ||
    format === "csv" ||
    format === "html" ||
    format === "markdown"
  ) {
    const outputString =
      format === "sarif"
        ? formatScanResults(filteredResults, "sarif", { aiFindings: filteredAiFindings })
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

  // Warn on stderr regardless of output format: with --format json|sarif|...
  // the scan would otherwise silently skip these entries, and stderr cannot
  // corrupt the structured report on stdout.
  if (unreadable.length > 0) {
    const entryLabel = isSinceMode ? "changed" : "staged";
    console.warn(
      `⚠️  [SecureFlow] Could not read ${unreadable.length} ${entryLabel} entr${
        unreadable.length === 1 ? "y" : "ies"
      } (submodule, symlink or conflicted): ${unreadable.join(", ")}`,
    );
  }

  const activeThreshold = failOnThreshold ?? parseFailOnArg();
  // Exit-code decision uses UNFILTERED aiFindings: --severity is a display
  // filter, not a security gate bypass. --fail-on must see every finding.
  const shouldFail = shouldFailScan(violationCount, allAiFindings, activeThreshold);
  const blockingAi = blockingAiFindings(allAiFindings, activeThreshold);

  if (format === "text") {
    const counts = countFindingsBySeverity(violationCount, allAiFindings);
    console.log(formatSeverityCounts(counts));
  }

  if (voiceEnabled) {
    const summaryText = generateVoiceSummaryText(violationCount, allAiFindings, !shouldFail);
    await playVoiceDebrief(summaryText, {
      files: stagedForAi,
      verbose: VERBOSE,
    });
  }

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
      const modeLabel = isSinceMode ? `changed file(s) since ${sinceRef}` : "staged file(s)";
      console.log(`✅ SecureFlow scan passed (${filesToScan.length} ${modeLabel}).`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Last-resort handler: without it an unexpected throw (e.g. an
    // unwritable -o path) surfaces as a raw UnhandledPromiseRejection
    // stack and an exit code that depends on Node's rejection mode.
    console.error(
      `❌ [SecureFlow] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
    const hasFailOn = process.argv.some((a) => a === "--fail-on" || a.startsWith("--fail-on="));
    process.exit(hasFailOn ? 2 : 1);
  });
