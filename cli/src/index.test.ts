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
  parseOutputFormat: vi.fn(),
  parseOutputPath: vi.fn(),
  parseIgnoreFilePath: vi.fn(),
  parseVoiceArg: vi.fn(),
  playVoiceDebrief: vi.fn(),
  startMcpServer: vi.fn(),
}));

vi.mock("./git.js", () => ({
  GitError: errors.GitError,
  getStagedFiles: m.getStagedFiles,
  readStagedContent: m.readStagedContent,
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
}));
vi.mock("./lib/api-client.js", () => ({
  NetworkUnavailableError: errors.NetworkUnavailableError,
  requestAiFileScan: m.requestAiFileScan,
}));
vi.mock("./lib/local-mode.js", () => ({
  hostedAiScanSkipReason: m.hostedAiScanSkipReason,
  localModeEnv: m.localModeEnv,
}));
vi.mock("./lib/output-args.js", () => ({
  CliUsageError: errors.CliUsageError,
  parseOutputFormat: m.parseOutputFormat,
  parseOutputPath: m.parseOutputPath,
  parseIgnoreFilePath: m.parseIgnoreFilePath,
  parseVoiceArg: m.parseVoiceArg,
}));
vi.mock("./lib/audio-player.js", () => ({ playVoiceDebrief: m.playVoiceDebrief }));
vi.mock("./mcp/index.js", () => ({ startMcpServer: m.startMcpServer }));

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
  m.parseVoiceArg.mockReturnValue(false);
  m.getStagedFiles.mockReturnValue([]);
  m.readStagedContent.mockReturnValue("const a = 1;");
  m.loadSecureFlowIgnore.mockReturnValue(null);
  m.scanFile.mockImplementation((path: string) => scanResult(path));
  m.filterBySeverity.mockImplementation((results: unknown) => results);
  m.formatScanResults.mockReturnValue("FORMATTED");
  m.parseFailOnArg.mockReturnValue("high");
  m.shouldFailScan.mockReturnValue(false);
  m.blockingAiFindings.mockReturnValue([]);
  m.describeFailThreshold.mockReturnValue("high");
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
