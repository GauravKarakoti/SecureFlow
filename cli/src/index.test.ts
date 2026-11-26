import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";

const errors = vi.hoisted(() => {
  class GitError extends Error {}
  class CliUsageError extends Error {}
  class NetworkUnavailableError extends Error {}
  return { GitError, CliUsageError, NetworkUnavailableError };
});

const m = vi.hoisted(() => ({
  getStagedFiles: vi.fn(),
  readStagedContent: vi.fn(),
  scanFile: vi.fn(),
  formatScanResults: vi.fn(),
  parseFailOnArg: vi.fn(),
  shouldFailScan: vi.fn(),
  loadSecureFlowIgnore: vi.fn(),
  blockingAiFindings: vi.fn(),
  describeFailThreshold: vi.fn(),
  filterBySeverity: vi.fn(),
  parseSeverityFilter: vi.fn(),
  generateVoiceSummaryText: vi.fn(),
  requestAiFileScan: vi.fn(),
  hostedAiScanSkipReason: vi.fn(),
  localModeEnv: vi.fn(),
  validateCliAiConfig: vi.fn<() => { provider: string; model: string; baseUrl?: string }>(() => ({
    provider: "groq",
    model: "openai/gpt-oss-20b",
  })),
  parseOutputFormat: vi.fn(),
  parseOutputPath: vi.fn(),
  parseIgnoreFilePath: vi.fn(),
  parseConfigFilePath: vi.fn(),
  parseVoiceArg: vi.fn(),
  parseColorArg: vi.fn(),
  playVoiceDebrief: vi.fn(),
  startMcpServer: vi.fn(),
  getChangedFilesSince: vi.fn(),
  getStagedDiffLineNumbers: vi.fn(() => new Set<number>()),
  getStagedDiff: vi.fn(() => ""),
  installHook: vi.fn(),
  uninstallHook: vi.fn(),
  printHookHelp: vi.fn(),
  getRepoRoot: vi.fn(),
  parseSinceArg: vi.fn(),
  parseNoCacheArg: vi.fn(),
  parseCacheClearArg: vi.fn(),
  parseCachePruneArg: vi.fn(),
  parseCacheStatsArg: vi.fn(),
  parseCacheTtlArg: vi.fn(),
  parseCacheMaxSizeArg: vi.fn(),
  parseCacheDirArg: vi.fn(),
  parseIgnoreSuppressionsArg: vi.fn(() => false),
  parseTargetDirectoryArg: vi.fn(),
  parseStagedArg: vi.fn(() => false),
  parseBaselineArg: vi.fn(() => undefined),
  parseWatchArg: vi.fn(() => false),
  parseVerbosityArg: vi.fn(),
  parseQuietArg: vi.fn(),
  parseVerboseArg: vi.fn(),
  discoverWorkspaceFiles: vi.fn(),
  isGitRepository: vi.fn(() => true),
  getCacheEntry: vi.fn(),
  setCacheEntry: vi.fn(),
  clearCache: vi.fn(),
  pruneCache: vi.fn(),
  getCacheStats: vi.fn(),
  parseDurationMs: vi.fn(),
  parseSizeBytes: vi.fn(),
  resolveCacheDir: vi.fn(),
  runWatchMode: vi.fn().mockResolvedValue(0),
}));

vi.mock("./git.js", () => ({
  GitError: errors.GitError,
  getStagedFiles: m.getStagedFiles,
  readStagedContent: m.readStagedContent,
  getChangedFilesSince: m.getChangedFilesSince,
  getStagedDiffLineNumbers: m.getStagedDiffLineNumbers,
  getStagedDiff: m.getStagedDiff,
  getRepoRoot: m.getRepoRoot,
  isGitRepository: m.isGitRepository,
}));
vi.mock("./hook.js", () => ({
  installHook: m.installHook,
  uninstallHook: m.uninstallHook,
  printHookHelp: m.printHookHelp,
}));
vi.mock("./scanner.js", () => ({
  scanFile: m.scanFile,
  formatScanResults: m.formatScanResults,
  parseFailOnArg: m.parseFailOnArg,
  shouldFailScan: m.shouldFailScan,
  loadSecureFlowIgnore: m.loadSecureFlowIgnore,
  blockingAiFindings: m.blockingAiFindings,
  describeFailThreshold: m.describeFailThreshold,
  filterBySeverity: m.filterBySeverity,
  parseSeverityFilter: m.parseSeverityFilter,
  generateVoiceSummaryText: m.generateVoiceSummaryText,
  countFindingsBySeverity: (localCount: number, aiFindings: any[] = []) => {
    let critical = 0;
    let high = localCount;
    let medium = 0;
    let low = 0;
    for (const f of aiFindings) {
      const s = (f.severity || "LOW").toUpperCase();
      if (s === "CRITICAL") critical++;
      else if (s === "HIGH") high++;
      else if (s === "MEDIUM") medium++;
      else if (s === "LOW") low++;
    }
    return { critical, high, medium, low };
  },
  formatSeverityCounts: (c: any) =>
    `Findings by severity: critical: ${c.critical}, high: ${c.high}, medium: ${c.medium}, low: ${c.low}`,
  DEFAULT_IGNORE_PATTERNS: [],
  compileIgnorePatterns: vi.fn(() => []),
}));
vi.mock("./lib/api-client.js", () => ({
  NetworkUnavailableError: errors.NetworkUnavailableError,
  requestAiFileScan: m.requestAiFileScan,
}));
vi.mock("./lib/local-mode.js", () => ({
  hostedAiScanSkipReason: m.hostedAiScanSkipReason,
  localModeEnv: m.localModeEnv,
  validateCliAiConfig: m.validateCliAiConfig,
}));
vi.mock("./lib/output-args.js", () => ({
  CliUsageError: errors.CliUsageError,
  parseOutputFormat: m.parseOutputFormat,
  parseOutputPath: m.parseOutputPath,
  parseIgnoreFilePath: m.parseIgnoreFilePath,
  parseConfigFilePath: m.parseConfigFilePath,
  parseVoiceArg: m.parseVoiceArg,
  parseSinceArg: m.parseSinceArg,
  parseColorArg: m.parseColorArg,
  parseNoCacheArg: m.parseNoCacheArg,
  parseCacheClearArg: m.parseCacheClearArg,
  parseCachePruneArg: m.parseCachePruneArg,
  parseCacheStatsArg: m.parseCacheStatsArg,
  parseCacheTtlArg: m.parseCacheTtlArg,
  parseCacheMaxSizeArg: m.parseCacheMaxSizeArg,
  parseCacheDirArg: m.parseCacheDirArg,
  parseIgnoreSuppressionsArg: m.parseIgnoreSuppressionsArg,
  parseTargetDirectoryArg: m.parseTargetDirectoryArg,
  parseStagedArg: m.parseStagedArg,
  parseBaselineArg: m.parseBaselineArg,
  parseWatchArg: m.parseWatchArg,
  parseVerbosityArg: m.parseVerbosityArg,
  parseQuietArg: m.parseQuietArg,
  parseVerboseArg: m.parseVerboseArg,
}));
vi.mock("./workspace.js", () => ({
  discoverWorkspaceFiles: m.discoverWorkspaceFiles,
}));
vi.mock("./lib/audio-player.js", () => ({ playVoiceDebrief: m.playVoiceDebrief }));
vi.mock("./mcp/index.js", () => ({ startMcpServer: m.startMcpServer }));
vi.mock("./cache.js", () => ({
  getCacheEntry: m.getCacheEntry,
  setCacheEntry: m.setCacheEntry,
  clearCache: m.clearCache,
  pruneCache: m.pruneCache,
  getCacheStats: m.getCacheStats,
  parseDurationMs: m.parseDurationMs,
  parseSizeBytes: m.parseSizeBytes,
  resolveCacheDir: m.resolveCacheDir,
}));

vi.mock("./watch.js", () => ({ runWatchMode: m.runWatchMode }));
vi.mock("./lib/tui.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/tui.js")>();
  return {
    ...actual,
    initSecureFlow: vi.fn(actual.initSecureFlow),
  };
});

const violation = { line: 3, text: "console.log(secret)", reason: "secret" };
const scanResult = (path: string, violations: unknown[] = []) => ({
  path,
  violations,
  skipped: false,
});
const aiFinding = (severity = "high") => ({
  severity,
  type: "hardcoded-secret",
  fileLocation: "a.ts",
  lineStart: 3,
  description: "Secret exposed",
});

const originalArgv = process.argv;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;

const output = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flat().join("\n");

/**
 * index.ts reads process.argv and calls process.exit(main()) at import time,
 * so each test re-imports a fresh copy with the argv it wants.
 */
async function runCli(...args: string[]): Promise<number> {
  vi.resetModules();
  process.argv = ["node", "secureflow", ...args];
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await import("./index.js");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return exit.mock.calls[0]![0] as number;
}

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

  m.hostedAiScanSkipReason.mockReturnValue(null);
  m.localModeEnv.mockReturnValue({});
  m.parseOutputFormat.mockReturnValue("text");
  m.parseOutputPath.mockReturnValue(null);
  m.parseIgnoreFilePath.mockReturnValue(undefined);
  m.parseConfigFilePath.mockReturnValue(undefined);
  m.parseVoiceArg.mockReturnValue(false);
  m.parseSinceArg.mockReturnValue(undefined);
  m.parseNoCacheArg.mockReturnValue(false);
  m.parseCacheClearArg.mockReturnValue(false);
  m.parseCacheDirArg.mockReturnValue(undefined);
  m.parseVerbosityArg.mockImplementation((argv: readonly string[] = process.argv) => {
    let q = false;
    let v = false;
    for (const a of argv) {
      if (a === "--quiet" || a === "-q" || a.startsWith("--quiet=")) {
        const val = a.startsWith("--quiet=") ? a.slice("--quiet=".length).toLowerCase() : "true";
        if (val !== "false" && val !== "0") q = true;
      }
      if (a === "--verbose" || a.startsWith("--verbose=")) {
        const val = a.startsWith("--verbose=")
          ? a.slice("--verbose=".length).toLowerCase()
          : "true";
        if (val !== "false" && val !== "0") v = true;
      }
    }
    if (q && v) throw new errors.CliUsageError("--quiet and --verbose cannot be combined");
    if (q) return "quiet";
    if (v) return "verbose";
    return "normal";
  });
  m.parseQuietArg.mockImplementation((argv: readonly string[] = process.argv) => {
    return argv.some((a) => a === "--quiet" || a === "-q");
  });
  m.parseVerboseArg.mockImplementation((argv: readonly string[] = process.argv) => {
    return argv.some((a) => a === "--verbose");
  });
  m.getCacheEntry.mockReturnValue(null);
  m.setCacheEntry.mockReturnValue(undefined);
  m.clearCache.mockReturnValue({ cleared: true, count: 0, cacheDir: "/dummy/cache" });
  m.resolveCacheDir.mockReturnValue("/dummy/cache");
  m.getChangedFilesSince.mockReturnValue([]);
  m.getRepoRoot.mockReturnValue(process.cwd());
  m.parseColorArg.mockReturnValue(undefined);
  m.getStagedFiles.mockReturnValue([]);
  m.readStagedContent.mockReturnValue("const a = 1;");
  m.loadSecureFlowIgnore.mockReturnValue(null);
  m.scanFile.mockImplementation((path: string) => scanResult(path));
  m.filterBySeverity.mockImplementation((results: unknown) => results);
  m.formatScanResults.mockReturnValue("FORMATTED");
  m.parseFailOnArg.mockImplementation((args: string[] = process.argv) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a?.startsWith("--fail-on=")) return a.slice("--fail-on=".length).toUpperCase();
      if (a === "--fail-on" && args[i + 1]) return args[i + 1]!.toUpperCase();
    }
    return "high";
  });
  m.shouldFailScan.mockReturnValue(false);
  m.blockingAiFindings.mockReturnValue([]);
  m.describeFailThreshold.mockImplementation((t) =>
    t ? `the --fail-on=${t} threshold` : "the default HIGH/CRITICAL threshold",
  );
  m.generateVoiceSummaryText.mockReturnValue("summary");
  m.playVoiceDebrief.mockResolvedValue(undefined);
  m.requestAiFileScan.mockResolvedValue([]);
  m.startMcpServer.mockResolvedValue(undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("CLI help", () => {
  it.each(["--help", "-h"])("prints help and exits 0 for %s", async (flag) => {
    const code = await runCli(flag);
    expect(code).toBe(0);
    expect(output(logSpy)).toContain("Usage:");
    expect(m.getStagedFiles).not.toHaveBeenCalled();
  });
});

describe("mcp subcommand routing", () => {
  it("starts the MCP server and exits 0", async () => {
    const code = await runCli("mcp");
    expect(code).toBe(0);
    expect(m.startMcpServer).toHaveBeenCalledTimes(1);
    expect(m.getStagedFiles).not.toHaveBeenCalled();
  });

  it("passes parsed heartbeat and stall options to startMcpServer", async () => {
    const code = await runCli(
      "mcp",
      "--heartbeat-interval=15000",
      "--heartbeat-timeout=5000",
      "--stall-timeout=30000",
    );
    expect(code).toBe(0);
    expect(m.startMcpServer).toHaveBeenCalledWith({
      heartbeatIntervalMs: 15000,
      heartbeatTimeoutMs: 5000,
      stallTimeoutMs: 30000,
    });
  });

  it("awaits session.waitForClose when returned", async () => {
    let closed = false;
    const session = {
      waitForClose: vi.fn().mockImplementation(async () => {
        closed = true;
      }),
    };
    m.startMcpServer.mockResolvedValue(session);
    const code = await runCli("mcp");
    expect(code).toBe(0);
    expect(session.waitForClose).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });

  it("prints MCP help without starting the server", async () => {
    const code = await runCli("mcp", "--help");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain("Threat Intelligence MCP Server");
    expect(m.startMcpServer).not.toHaveBeenCalled();
  });

  it("exits 1 when the MCP server fails to start", async () => {
    m.startMcpServer.mockRejectedValue(new Error("port busy"));
    const code = await runCli("mcp");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("Failed to start MCP server: port busy");
  });
});

describe("argument and git errors", () => {
  it("exits 1 and prints the message on a CliUsageError", async () => {
    m.parseOutputFormat.mockImplementation(() => {
      throw new errors.CliUsageError("Unsupported format: xml");
    });
    const code = await runCli("--format", "xml");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("Unsupported format: xml");
    expect(m.getStagedFiles).not.toHaveBeenCalled();
  });

  it("exits 1 when reading staged files throws a GitError", async () => {
    m.getStagedFiles.mockImplementation(() => {
      throw new errors.GitError("not a git repository");
    });
    const code = await runCli();
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("not a git repository");
  });

  it("exits 1 when reading staged files throws an unknown error", async () => {
    m.getStagedFiles.mockImplementation(() => {
      throw new Error("boom");
    });
    const code = await runCli();
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("boom");
  });
});

describe("exit codes", () => {
  it("exits 0 with a success message when nothing is staged", async () => {
    const code = await runCli();
    expect(code).toBe(0);
    expect(output(logSpy)).toContain("scan passed (0 staged file(s))");
  });

  it("exits 0 when staged files are clean", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts", "b.ts"]);
    const code = await runCli();
    expect(code).toBe(0);
    expect(m.scanFile).toHaveBeenCalledTimes(2);
    expect(output(logSpy)).toContain("scan passed (2 staged file(s))");
  });

  it("exits 1 and reports a blocking secret-logging violation", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.scanFile.mockReturnValue(scanResult("a.ts", [violation]));
    m.shouldFailScan.mockReturnValue(true);
    const code = await runCli("--fail-on", "high");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("Secret logging detected in a.ts:3");
    expect(output(errorSpy)).toContain(
      "blocked this commit: 1 secret-logging violation at or above",
    );
  });

  it("pluralises the violation count", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.scanFile.mockReturnValue(scanResult("a.ts", [violation, violation]));
    m.shouldFailScan.mockReturnValue(true);
    await runCli();
    expect(output(errorSpy)).toContain("2 secret-logging violations");
  });

  it("exits 1 and reports blocking AI findings", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.requestAiFileScan.mockResolvedValue([aiFinding()]);
    m.blockingAiFindings.mockReturnValue([aiFinding()]);
    m.shouldFailScan.mockReturnValue(true);
    const code = await runCli();
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("[SecureFlow AI] high hardcoded-secret in a.ts:3");
    expect(output(errorSpy)).toContain("1 AI-detected finding");
  });

  it("exits 0 with an advisory warning when findings are below the threshold", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.scanFile.mockReturnValue(scanResult("a.ts", [violation]));
    m.shouldFailScan.mockReturnValue(false);
    const code = await runCli();
    expect(code).toBe(0);
    expect(output(logSpy)).toContain("advisory warning: 1 finding below");
  });

  it("does not let --severity hide findings from the --fail-on decision", async () => {
    const low = aiFinding("low");
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.parseSeverityFilter.mockReturnValue(new Set(["high"]));
    m.requestAiFileScan.mockResolvedValue([low]);
    await runCli("--severity", "high");
    expect(m.shouldFailScan).toHaveBeenCalledWith(0, [low], "high");
    expect(output(errorSpy)).not.toContain("[SecureFlow AI]");
  });
});

describe("unreadable staged entries", () => {
  it("warns and skips entries whose content cannot be read", async () => {
    m.getStagedFiles.mockReturnValue(["submodule"]);
    m.readStagedContent.mockReturnValue(null);
    const code = await runCli();
    expect(code).toBe(0);
    expect(m.scanFile).not.toHaveBeenCalled();
    expect(output(warnSpy)).toContain("Could not read 1 staged entry");
    expect(output(warnSpy)).toContain("submodule");
  });

  it("still warns on stderr when a structured output format is selected", async () => {
    m.parseOutputFormat.mockReturnValue("json");
    m.getStagedFiles.mockReturnValue(["submodule"]);
    m.readStagedContent.mockReturnValue(null);
    const code = await runCli("--format", "json");
    expect(code).toBe(0);
    expect(output(warnSpy)).toContain("Could not read 1 staged entry");
    expect(output(warnSpy)).toContain("submodule");
  });
});

describe("output formats", () => {
  it("prints formatted results to stdout when no output path is given", async () => {
    m.parseOutputFormat.mockReturnValue("json");
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    await runCli("--format", "json");
    expect(m.formatScanResults).toHaveBeenCalledWith([scanResult("a.ts")], "json");
    expect(output(logSpy)).toContain("FORMATTED");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("writes the report to the output path", async () => {
    m.parseOutputFormat.mockReturnValue("sarif");
    m.parseOutputPath.mockReturnValue("out.sarif");
    await runCli("--format", "sarif", "-o", "out.sarif");
    expect(writeSpy).toHaveBeenCalledWith("out.sarif", "FORMATTED", "utf-8");
    expect(output(logSpy)).toContain("exported in SARIF format to out.sarif");
  });

  it("does not write files with --dry-run", async () => {
    m.parseOutputFormat.mockReturnValue("json");
    m.parseOutputPath.mockReturnValue("out.json");
    await runCli("--format", "json", "-o", "out.json", "--dry-run");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain("[DRY RUN] Would write to out.json");
  });

  it("writes a text report when text format has an output path", async () => {
    m.parseOutputPath.mockReturnValue("report.txt");
    await runCli("-o", "report.txt");
    expect(m.formatScanResults).toHaveBeenCalledWith([], "text");
    expect(writeSpy).toHaveBeenCalledWith("report.txt", "FORMATTED", "utf-8");
    expect(output(logSpy)).toContain("Scan report written to report.txt");
  });

  it("does not format anything for plain text output without a path", async () => {
    await runCli();
    expect(m.formatScanResults).not.toHaveBeenCalled();
  });
});

describe("AI scan integration", () => {
  it("sends non-skipped staged files to the AI scan", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.readStagedContent.mockReturnValue("const x = 1;");
    await runCli();
    expect(m.requestAiFileScan).toHaveBeenCalledWith([{ path: "a.ts", content: "const x = 1;" }]);
  });

  it("does not send ignored files to the AI scan", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.scanFile.mockReturnValue({ path: "a.ts", violations: [], skipped: "ignored" });
    await runCli();
    expect(m.requestAiFileScan).not.toHaveBeenCalled();
  });

  it("skips the hosted AI scan in local mode", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.hostedAiScanSkipReason.mockReturnValue("local");
    const code = await runCli("--local", "--verbose");
    expect(code).toBe(0);
    expect(m.requestAiFileScan).not.toHaveBeenCalled();
    expect(output(warnSpy)).toContain("hosted AI scan skipped");
  });

  it("continues with the local scan when the network is unavailable", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    m.requestAiFileScan.mockRejectedValue(new errors.NetworkUnavailableError("offline"));
    const code = await runCli("--verbose");
    expect(code).toBe(0);
    expect(output(warnSpy)).toContain("AI scan unreachable");
  });

  it("applies the local-mode environment variables", async () => {
    m.localModeEnv.mockReturnValue({ LOCAL_AI_MODEL: "llama3" });
    await runCli("--local", "--local-model", "llama3");
    expect(process.env.LOCAL_AI_MODEL).toBe("llama3");
    delete process.env.LOCAL_AI_MODEL;
  });

  it("prints the active AI model in verbose mode", async () => {
    m.validateCliAiConfig.mockReturnValue({
      provider: "ollama",
      model: "codellama",
      baseUrl: "http://localhost:11434/v1",
    });
    m.getStagedFiles.mockReturnValue([]);
    const code = await runCli("--verbose");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain(
      "Active AI model: provider=ollama, model=codellama, baseUrl=http://localhost:11434/v1",
    );
  });

  it("exits 1 and prints an error when AI configuration is invalid at startup", async () => {
    m.validateCliAiConfig.mockImplementation(() => {
      throw new Error('Invalid AI provider "bad-provider"');
    });
    const code = await runCli();
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain(
      '❌ [SecureFlow] Configuration Error: Invalid AI provider "bad-provider"',
    );
  });
});

describe("voice debrief", () => {
  it("plays the voice summary when --voice is enabled", async () => {
    m.parseVoiceArg.mockReturnValue(true);
    m.getStagedFiles.mockReturnValue(["a.ts"]);
    await runCli("--voice");
    expect(m.generateVoiceSummaryText).toHaveBeenCalledWith(0, [], true);
    expect(m.playVoiceDebrief).toHaveBeenCalledWith("summary", {
      files: [{ path: "a.ts", content: "const a = 1;" }],
      verbose: false,
    });
  });

  it("does not play audio by default", async () => {
    await runCli();
    expect(m.playVoiceDebrief).not.toHaveBeenCalled();
  });
});

describe("--init flag & initialization modes (#1758)", () => {
  it("initializes secureflow and prints greeting with exit code 0 on success", async () => {
    const { initSecureFlow } = await import("./lib/tui.js");
    vi.mocked(initSecureFlow).mockResolvedValueOnce({
      success: true,
      message: "Successfully added npx secureflow to package.json prepare script",
      hookPath: "package.json",
    });

    const code = await runCli("--init", "blank");
    expect(code).toBe(0);
    expect(initSecureFlow).toHaveBeenCalled();
    expect(output(logSpy)).toContain("[SecureFlow Init]");
  });

  it("exits with code 1 when initialization fails", async () => {
    const { initSecureFlow } = await import("./lib/tui.js");
    vi.mocked(initSecureFlow).mockResolvedValueOnce({
      success: false,
      message: "Failed to write package.json",
      hookPath: "",
    });

    const code = await runCli("--init", "--blank");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("Failed to write package.json");
  });

  it("supports 'init' subcommand as an alternative to '--init'", async () => {
    const { initSecureFlow } = await import("./lib/tui.js");
    vi.mocked(initSecureFlow).mockResolvedValueOnce({
      success: true,
      message: "Successfully initialized configuration",
      hookPath: ".husky/pre-commit",
    });

    const code = await runCli("init");
    expect(code).toBe(0);
    expect(initSecureFlow).toHaveBeenCalled();
    expect(output(logSpy)).toContain("[SecureFlow Init]");
  });
});

describe("validate command (#1898)", () => {
  it("exits with code 0 when all configuration files are valid", async () => {
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).endsWith(".json")) {
        return JSON.stringify({ gate: { blockOn: "HIGH" } });
      }
      return "[paths]\nnode_modules/**\n";
    });

    const code = await runCli("validate");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain("Configuration validation passed");

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("exits with code 1 and prints line numbers when configuration has errors", async () => {
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).endsWith(".json")) {
        return '{\n  "gate": {\n    "blockOn": "SUPER_CRITICAL"\n  }\n}';
      }
      return "[paths]\nnode_modules/**\n";
    });

    const code = await runCli("validate");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("Configuration validation failed");
    expect(output(errorSpy)).toContain(".secureflow.json:3");
    expect(output(errorSpy)).toContain('Invalid severity "SUPER_CRITICAL"');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe("--since flag (#1760)", () => {
  it("scans files changed since reference and outputs passed summary", async () => {
    m.parseSinceArg.mockReturnValue("origin/main");
    m.getChangedFilesSince.mockReturnValue(["changed.ts"]);
    m.getRepoRoot.mockReturnValue("/repo");

    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const readSpy = vi.spyOn(fs, "readFileSync").mockReturnValue("const x = 1;" as never);

    const code = await runCli("--since", "origin/main");
    expect(code).toBe(0);
    expect(m.getChangedFilesSince).toHaveBeenCalledWith("origin/main");
    expect(m.getStagedFiles).not.toHaveBeenCalled();
    expect(m.scanFile).toHaveBeenCalledWith("changed.ts", "const x = 1;", [], expect.anything());
    expect(output(logSpy)).toContain(
      "✅ SecureFlow scan passed (1 changed file(s) since origin/main).",
    );

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("exits with code 1 when getChangedFilesSince throws a GitError", async () => {
    m.parseSinceArg.mockReturnValue("invalid-ref");
    m.getChangedFilesSince.mockImplementation(() => {
      throw new errors.GitError('Git reference "invalid-ref" does not exist.');
    });

    const code = await runCli("--since", "invalid-ref");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain('Git reference "invalid-ref" does not exist.');
  });
});

describe("caching and cache-clear flags", () => {
  it("clears cache and exits 0 when cache-clear is invoked", async () => {
    m.parseCacheClearArg.mockReturnValue(true);
    m.clearCache.mockReturnValue({ cleared: true, count: 5, cacheDir: "/dummy/cache" });

    const code = await runCli("cache-clear");
    expect(code).toBe(0);
    expect(m.clearCache).toHaveBeenCalledTimes(1);
    expect(output(logSpy)).toContain("Cache cleared successfully (5 entries removed).");
    expect(m.getStagedFiles).not.toHaveBeenCalled();
  });

  it("exits 1 when cache-clear fails", async () => {
    m.parseCacheClearArg.mockReturnValue(true);
    m.clearCache.mockReturnValue({ cleared: false, count: 0, cacheDir: "/dummy/cache" });

    const code = await runCli("cache-clear");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("Failed to clear cache directory");
  });

  it("reuses cached scan result and skips scanFile on cache hit", async () => {
    m.getStagedFiles.mockReturnValue(["cached.ts"]);
    m.readStagedContent.mockReturnValue("const x = 1;");
    m.getCacheEntry.mockReturnValue({
      version: 1,
      rulesetVersion: "1.0.0",
      contentHash: "hash123",
      filePath: "cached.ts",
      result: scanResult("cached.ts", []),
      cachedAt: Date.now(),
    });

    const code = await runCli();
    expect(code).toBe(0);
    expect(m.getCacheEntry).toHaveBeenCalledTimes(1);
    expect(m.scanFile).not.toHaveBeenCalled();
    expect(m.setCacheEntry).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain("Analyzed 0 file(s) (1 cached).");
  });

  it("scans file and writes to cache on cache miss", async () => {
    m.getStagedFiles.mockReturnValue(["new.ts"]);
    m.readStagedContent.mockReturnValue("const y = 2;");
    m.getCacheEntry.mockReturnValue(null);
    m.scanFile.mockReturnValue(scanResult("new.ts", []));

    const code = await runCli();
    expect(code).toBe(0);
    expect(m.getCacheEntry).toHaveBeenCalledTimes(1);
    expect(m.scanFile).toHaveBeenCalledTimes(1);
    expect(m.setCacheEntry).toHaveBeenCalledTimes(1);
    expect(output(logSpy)).toContain("Analyzed 1 file(s) (0 cached).");
  });

  it("reports the number of skipped files in verbose mode", async () => {
    m.getStagedFiles.mockReturnValue(["a.ts", "b.ts"]);
    m.readStagedContent.mockReturnValue("const x = 1;");
    m.scanFile.mockImplementation((filePath: string) => {
      if (filePath === "b.ts") {
        return { path: filePath, violations: [], skipped: "matched .secureflowignore" };
      }
      return scanResult(filePath, []);
    });

    const code = await runCli("--verbose");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain("Skipped 1 file(s) (ignored or excluded).");
  });

  it("bypasses cache when --no-cache is passed", async () => {
    m.parseNoCacheArg.mockReturnValue(true);
    m.getStagedFiles.mockReturnValue(["file.ts"]);
    m.readStagedContent.mockReturnValue("const z = 3;");
    m.scanFile.mockReturnValue(scanResult("file.ts", []));

    const code = await runCli("--no-cache");
    expect(code).toBe(0);
    expect(m.getCacheEntry).not.toHaveBeenCalled();
    expect(m.scanFile).toHaveBeenCalledTimes(1);
    expect(m.setCacheEntry).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain("Analyzed 1 file(s) (0 cached).");
  });

  it("prunes cache and outputs summary when cache-prune is invoked", async () => {
    m.parseCachePruneArg.mockReturnValue(true);
    m.parseCacheTtlArg.mockReturnValue("7d");
    m.parseDurationMs.mockReturnValue(7 * 24 * 60 * 60 * 1000);
    m.pruneCache.mockReturnValue({
      prunedCount: 5,
      freedBytes: 1024 * 50,
      remainingCount: 10,
      remainingBytes: 1024 * 100,
      cacheDir: "/dummy/cache",
    });

    const code = await runCli("cache-prune", "--ttl", "7d");
    expect(code).toBe(0);
    expect(m.pruneCache).toHaveBeenCalledWith({
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      maxSizeBytes: undefined,
      cacheDir: undefined,
      cwd: expect.any(String),
    });
    expect(output(logSpy)).toContain("Cache pruned: 5 entries removed");
    expect(output(logSpy)).toContain("10 remaining");
  });

  it("prints cache statistics when cache-stats is invoked", async () => {
    m.parseCacheStatsArg.mockReturnValue(true);
    m.getCacheStats.mockReturnValue({
      cacheDir: "/dummy/cache",
      entryCount: 12,
      totalSizeBytes: 1024 * 200,
      tempFileCount: 0,
      tempSizeBytes: 0,
      oldestEntryAt: Date.now() - 100000,
      newestEntryAt: Date.now(),
      rulesetVersions: { "1.0.0": 12 },
    });

    const code = await runCli("cache-stats");
    expect(code).toBe(0);
    expect(m.getCacheStats).toHaveBeenCalled();
    expect(output(logSpy)).toContain("Scan Cache Statistics");
    expect(output(logSpy)).toContain("Total Entries:     12");
  });
});

describe("directory scanning and non-git fallback (#1933)", () => {
  it("scans files in target directory when positional target is provided", async () => {
    m.parseTargetDirectoryArg.mockReturnValue("src");
    m.discoverWorkspaceFiles.mockReturnValue(["src/index.ts"]);
    m.scanFile.mockReturnValue(scanResult("src/index.ts", []));

    const code = await runCli("src");
    expect(code).toBe(0);
    expect(m.discoverWorkspaceFiles).toHaveBeenCalledWith(
      "src",
      expect.objectContaining({ workspaceRoot: expect.any(String) }),
    );
    expect(m.getStagedFiles).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain("SecureFlow scan passed (1 file(s) in src).");
  });

  it("falls back gracefully to current directory scan when not inside a git repository", async () => {
    m.isGitRepository.mockReturnValue(false);
    m.discoverWorkspaceFiles.mockReturnValue(["package.json"]);
    m.scanFile.mockReturnValue(scanResult("package.json", []));

    const code = await runCli();
    expect(code).toBe(0);
    expect(m.discoverWorkspaceFiles).toHaveBeenCalledWith(
      ".",
      expect.objectContaining({ workspaceRoot: expect.any(String) }),
    );
    expect(m.getStagedFiles).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain("SecureFlow scan passed (1 file(s) in directory).");
  });
});

describe("--fail-on thresholds, exit codes, and severity counts", () => {
  beforeEach(() => {
    m.getStagedFiles.mockReturnValue(["src/app.ts"]);
    m.readStagedContent.mockReturnValue("const x = 1;");
    m.scanFile.mockReturnValue(scanResult("src/app.ts", []));
  });

  it("exits 0 when findings are below the critical threshold", async () => {
    const high = aiFinding("high");
    m.requestAiFileScan.mockResolvedValue([high]);
    m.shouldFailScan.mockReturnValue(false);

    const code = await runCli("--fail-on", "critical");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 0, high: 1, medium: 0, low: 0",
    );
    expect(output(logSpy)).toContain("below the --fail-on=CRITICAL threshold");
  });

  it("exits 1 when findings meet or exceed the critical threshold", async () => {
    const critical = aiFinding("critical");
    m.requestAiFileScan.mockResolvedValue([critical]);
    m.blockingAiFindings.mockReturnValue([critical]);
    m.shouldFailScan.mockReturnValue(true);

    const code = await runCli("--fail-on", "critical");
    expect(code).toBe(1);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 1, high: 0, medium: 0, low: 0",
    );
    expect(output(errorSpy)).toContain(
      "blocked this commit: 1 AI-detected finding at or above the --fail-on=CRITICAL threshold",
    );
  });

  it("exits 0 when findings are below the high threshold", async () => {
    const medium = aiFinding("medium");
    m.requestAiFileScan.mockResolvedValue([medium]);
    m.shouldFailScan.mockReturnValue(false);

    const code = await runCli("--fail-on", "high");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 0, high: 0, medium: 1, low: 0",
    );
  });

  it("exits 1 when findings meet or exceed the high threshold", async () => {
    const high = aiFinding("high");
    m.requestAiFileScan.mockResolvedValue([high]);
    m.blockingAiFindings.mockReturnValue([high]);
    m.shouldFailScan.mockReturnValue(true);

    const code = await runCli("--fail-on", "high");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain(
      "blocked this commit: 1 AI-detected finding at or above the --fail-on=HIGH threshold",
    );
  });

  it("exits 0 when findings are below the medium threshold", async () => {
    const low = aiFinding("low");
    m.requestAiFileScan.mockResolvedValue([low]);
    m.shouldFailScan.mockReturnValue(false);

    const code = await runCli("--fail-on", "medium");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 0, high: 0, medium: 0, low: 1",
    );
  });

  it("exits 1 when findings meet or exceed the medium threshold", async () => {
    const medium = aiFinding("medium");
    m.requestAiFileScan.mockResolvedValue([medium]);
    m.blockingAiFindings.mockReturnValue([medium]);
    m.shouldFailScan.mockReturnValue(true);

    const code = await runCli("--fail-on", "medium");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain(
      "blocked this commit: 1 AI-detected finding at or above the --fail-on=MEDIUM threshold",
    );
  });

  it("exits 0 when no findings exist with --fail-on low", async () => {
    m.requestAiFileScan.mockResolvedValue([]);
    m.shouldFailScan.mockReturnValue(false);

    const code = await runCli("--fail-on", "low");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 0, high: 0, medium: 0, low: 0",
    );
    expect(output(logSpy)).toContain("SecureFlow scan passed");
  });

  it("exits 1 when low findings are met with --fail-on low", async () => {
    const low = aiFinding("low");
    m.requestAiFileScan.mockResolvedValue([low]);
    m.blockingAiFindings.mockReturnValue([low]);
    m.shouldFailScan.mockReturnValue(true);

    const code = await runCli("--fail-on", "low");
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain(
      "blocked this commit: 1 AI-detected finding at or above the --fail-on=LOW threshold",
    );
  });

  it("exits 0 in advisory mode with --fail-on none even when critical findings exist", async () => {
    const critical = aiFinding("critical");
    m.requestAiFileScan.mockResolvedValue([critical]);
    m.shouldFailScan.mockReturnValue(false);

    const code = await runCli("--fail-on", "none");
    expect(code).toBe(0);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 1, high: 0, medium: 0, low: 0",
    );
    expect(output(logSpy)).toContain("advisory warning: 1 finding below");
  });

  it("supports secureflow scan --fail-on high subcommand syntax", async () => {
    const high = aiFinding("high");
    m.requestAiFileScan.mockResolvedValue([high]);
    m.blockingAiFindings.mockReturnValue([high]);
    m.shouldFailScan.mockReturnValue(true);

    const code = await runCli("scan", "--fail-on", "high");
    expect(code).toBe(1);
    expect(output(logSpy)).toContain(
      "Findings by severity: critical: 0, high: 1, medium: 0, low: 0",
    );
  });

  it("exits 2 on scan error when --fail-on is specified", async () => {
    m.getStagedFiles.mockImplementation(() => {
      throw new errors.GitError("fatal: not a git repository");
    });

    const code = await runCli("--fail-on", "high");
    expect(code).toBe(2);
    expect(output(errorSpy)).toContain("fatal: not a git repository");
  });

  it("retains default exit code 1 on scan error when --fail-on is omitted", async () => {
    m.getStagedFiles.mockImplementation(() => {
      throw new errors.GitError("fatal: not a git repository");
    });

    const code = await runCli();
    expect(code).toBe(1);
    expect(output(errorSpy)).toContain("fatal: not a git repository");
  });

  describe("Verbosity and progress indicator (--quiet, --verbose) (#1978)", () => {
    it("prints only summary and errors in --quiet mode when clean", async () => {
      m.getStagedFiles.mockReturnValue(["a.ts"]);
      m.readStagedContent.mockReturnValue("const x = 1;");
      m.scanFile.mockReturnValue(scanResult("a.ts", []));

      const code = await runCli("--quiet");
      expect(code).toBe(0);
      const out = output(logSpy);
      expect(out).toContain("Findings by severity: critical: 0, high: 0, medium: 0, low: 0");
      expect(out).toContain("SecureFlow scan passed");
      expect(out).not.toContain("Analyzed");
      expect(out).not.toContain("scanned");
      expect(out).not.toContain("✨ No security violations");
      expect(output(errorSpy)).toBe("");
    });

    it("prints only summary and errors in -q mode when violations exist", async () => {
      m.getStagedFiles.mockReturnValue(["a.ts"]);
      m.readStagedContent.mockReturnValue("console.log(password);");
      m.scanFile.mockReturnValue(scanResult("a.ts", [violation]));
      m.shouldFailScan.mockReturnValue(true);

      const code = await runCli("-q");
      expect(code).toBe(1);
      const errOut = output(errorSpy);
      expect(errOut).toContain("Secret logging detected in a.ts:3");
      expect(errOut).toContain("SecureFlow blocked this commit");
      const out = output(logSpy);
      expect(out).toContain("Findings by severity: critical: 0, high: 1, medium: 0, low: 0");
      expect(out).not.toContain("Analyzed");
      expect(out).not.toContain("scanned");
    });

    it("prints per-file timing and skipped files in --verbose mode", async () => {
      m.getStagedFiles.mockReturnValue(["a.ts", "b.ts"]);
      m.readStagedContent.mockReturnValue("const x = 1;");
      m.scanFile.mockImplementation((filePath: string) => {
        if (filePath === "b.ts") {
          return { path: filePath, violations: [], skipped: "matched .secureflowignore" };
        }
        return scanResult(filePath, []);
      });

      const code = await runCli("--verbose");
      expect(code).toBe(0);
      const out = output(logSpy);
      expect(out).toMatch(/✓ scanned a\.ts \(\d+(\.\d+)?ms\)/);
      expect(out).toContain("↷ skipped b.ts (matched .secureflowignore)");
      expect(out).toContain("Skipped 1 file(s) (ignored or excluded).");
      expect(out).toContain("Analyzed 2 file(s) (0 cached).");
    });

    it("fails with exit code 1 when --quiet and --verbose are combined", async () => {
      const code = await runCli("--quiet", "--verbose");
      expect(code).toBe(1);
      expect(output(errorSpy)).toContain("--quiet and --verbose cannot be combined");
    });

    it("fails with exit code 1 when -q and --verbose are combined", async () => {
      const code = await runCli("-q", "--verbose");
      expect(code).toBe(1);
      expect(output(errorSpy)).toContain("--quiet and --verbose cannot be combined");
    });

    it("contains no progress characters when output is piped or redirected (non-terminal)", async () => {
      m.getStagedFiles.mockReturnValue(["a.ts", "b.ts"]);
      m.readStagedContent.mockReturnValue("const x = 1;");
      m.scanFile.mockReturnValue(scanResult("a.ts", []));

      // With non-TTY stderr/stdout
      const stderrWriteSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((() => true) as any);
      try {
        const code = await runCli();
        expect(code).toBe(0);
        // Ensure no progress indicator updates were written to stderr
        const stderrCalls = stderrWriteSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(stderrCalls).not.toContain("Scanning files (");
      } finally {
        stderrWriteSpy.mockRestore();
      }
    });
  });

  describe("hook subcommand and staged scan routing (#2020)", () => {
    it("delegates to installHook on 'secureflow hook install'", async () => {
      m.installHook.mockResolvedValue({ success: true, message: "Hook installed successfully" });
      const code = await runCli("hook", "install");
      expect(code).toBe(0);
      expect(m.installHook).toHaveBeenCalledWith({ force: false, dryRun: false });
      expect(output(logSpy)).toContain("Hook installed successfully");
    });

    it("passes --force and --dry-run to installHook", async () => {
      m.installHook.mockResolvedValue({ success: true, message: "Hook force installed" });
      const code = await runCli("hook", "install", "--force", "--dry-run");
      expect(code).toBe(0);
      expect(m.installHook).toHaveBeenCalledWith({ force: true, dryRun: true });
    });

    it("returns exit code 1 when installHook fails", async () => {
      m.installHook.mockResolvedValue({ success: false, message: "Failed to install hook" });
      const code = await runCli("hook", "install");
      expect(code).toBe(1);
      expect(output(errorSpy)).toContain("Failed to install hook");
    });

    it("delegates to uninstallHook on 'secureflow hook uninstall'", async () => {
      m.uninstallHook.mockResolvedValue({
        success: true,
        message: "Hook uninstalled successfully",
      });
      const code = await runCli("hook", "uninstall");
      expect(code).toBe(0);
      expect(m.uninstallHook).toHaveBeenCalledWith({ dryRun: false });
      expect(output(logSpy)).toContain("Hook uninstalled successfully");
    });

    it("returns exit code 1 when uninstallHook fails", async () => {
      m.uninstallHook.mockResolvedValue({ success: false, message: "Failed to uninstall hook" });
      const code = await runCli("hook", "uninstall");
      expect(code).toBe(1);
      expect(output(errorSpy)).toContain("Failed to uninstall hook");
    });

    it("prints hook help on 'secureflow hook --help'", async () => {
      const code = await runCli("hook", "--help");
      expect(code).toBe(0);
      expect(m.printHookHelp).toHaveBeenCalled();
    });

    it("fails with exit code 1 on unknown hook action", async () => {
      const code = await runCli("hook", "unknown-action");
      expect(code).toBe(1);
      expect(output(errorSpy)).toContain('Unknown hook command "unknown-action"');
    });

    it("fails when --staged is used outside a git repository", async () => {
      m.parseStagedArg.mockReturnValue(true);
      m.isGitRepository.mockReturnValue(false);
      const code = await runCli("scan", "--staged");
      expect(code).toBe(1);
      expect(output(errorSpy)).toContain("Not a git repository");
    });

    it("delegates to runWatchMode when --watch is supplied", async () => {
      m.parseWatchArg.mockReturnValue(true);
      m.runWatchMode.mockResolvedValue(0);
      const code = await runCli("--watch");
      expect(code).toBe(0);
      expect(m.runWatchMode).toHaveBeenCalled();
    });
  });
});
