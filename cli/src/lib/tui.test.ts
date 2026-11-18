import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

import {
  colors,
  TerminalSpinner,
  formatSeverityBadge,
  renderWarningTable,
  formatTuiScanSummary,
  initHuskyPreCommitHook,
  initBlankPrepareScript,
  detectInitMode,
  promptInitChoice,
  initSecureFlow,
  formatInitGreeting,
  setColorEnabled,
  getColorOverride,
  isColorSupported,
  resolveColorSupport,
  stripAnsi,
  hasAnsi,
  type TableRow,
} from "./tui.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("cli/src/lib/tui (#1712)", () => {
  describe("ANSI colors and styling", () => {
    it("decorates strings with ANSI codes when enabled", () => {
      expect(colors.red("test")).toContain("test");
      expect(colors.green("ok")).toContain("ok");
      expect(colors.bold("bold")).toContain("bold");
    });

    it("formats severity badges with corresponding highlights", () => {
      const crit = formatSeverityBadge("CRITICAL");
      const high = formatSeverityBadge("HIGH");
      const med = formatSeverityBadge("MEDIUM");
      const low = formatSeverityBadge("LOW");

      expect(crit).toContain("CRITICAL");
      expect(high).toContain("HIGH");
      expect(med).toContain("MEDIUM");
      expect(low).toContain("LOW");
    });
  });

  describe("NO_COLOR, CLI flags, and TTY detection", () => {
    const origEnv = process.env;
    const origArgv = process.argv;

    beforeEach(() => {
      setColorEnabled(null);
      process.env = { ...origEnv };
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
      process.argv = ["node", "secureflow"];
    });

    afterEach(() => {
      setColorEnabled(null);
      process.env = origEnv;
      process.argv = origArgv;
    });

    describe("isColorSupported / resolveColorSupport", () => {
      it("disables color automatically when output is not a TTY (piped output)", () => {
        expect(resolveColorSupport({ isTTY: false })).toBe(false);
        expect(resolveColorSupport({ stream: { isTTY: false } })).toBe(false);
      });

      it("enables color in an interactive terminal (isTTY = true) by default", () => {
        expect(resolveColorSupport({ isTTY: true })).toBe(true);
        expect(resolveColorSupport({ stream: { isTTY: true } })).toBe(true);
      });

      it("disables color when NO_COLOR environment variable is set", () => {
        expect(resolveColorSupport({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
        expect(resolveColorSupport({ isTTY: true, env: { NO_COLOR: "true" } })).toBe(false);
        expect(resolveColorSupport({ isTTY: true, env: { NO_COLOR: "anything" } })).toBe(false);
      });

      it("does not disable color when NO_COLOR is an empty string per no-color.org", () => {
        expect(resolveColorSupport({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
      });

      it("disables color when --no-color flag is passed even on an interactive TTY", () => {
        expect(resolveColorSupport({ isTTY: true, argv: ["node", "secureflow", "--no-color"] })).toBe(false);
      });

      it("allows --color flag to force color on even when output is not a TTY (piped)", () => {
        expect(resolveColorSupport({ isTTY: false, argv: ["node", "secureflow", "--color"] })).toBe(true);
      });

      it("allows --color flag to override NO_COLOR", () => {
        expect(
          resolveColorSupport({
            isTTY: false,
            env: { NO_COLOR: "1" },
            argv: ["node", "secureflow", "--color"],
          }),
        ).toBe(true);
      });

      it("respects FORCE_COLOR=0 and FORCE_COLOR=1", () => {
        expect(resolveColorSupport({ isTTY: true, env: { FORCE_COLOR: "0" } })).toBe(false);
        expect(resolveColorSupport({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
      });

      it("respects programmatic setColorEnabled override", () => {
        setColorEnabled(true);
        expect(getColorOverride()).toBe(true);
        expect(isColorSupported()).toBe(true);
        setColorEnabled(false);
        expect(getColorOverride()).toBe(false);
        expect(isColorSupported()).toBe(false);
        setColorEnabled(null);
        expect(getColorOverride()).toBeNull();
      });
    });

    describe("No ANSI escape codes appear when color is disabled", () => {
      beforeEach(() => {
        setColorEnabled(false);
      });

      it("colors methods return plain unescaped strings", () => {
        expect(hasAnsi(colors.red("sample text"))).toBe(false);
        expect(colors.red("sample text")).toBe("sample text");
        expect(hasAnsi(colors.green("ok"))).toBe(false);
        expect(colors.green("ok")).toBe("ok");
        expect(hasAnsi(colors.bold("heading"))).toBe(false);
        expect(colors.bold("heading")).toBe("heading");
        expect(hasAnsi(colors.bgRed("danger"))).toBe(false);
        expect(colors.bgRed("danger")).toBe("danger");
      });

      it("formatSeverityBadge contains no ANSI escape codes", () => {
        for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]) {
          const badge = formatSeverityBadge(sev);
          expect(hasAnsi(badge)).toBe(false);
          expect(badge).toBe(stripAnsi(badge));
        }
      });

      it("renderWarningTable contains no ANSI escape codes", () => {
        const table = renderWarningTable([
          {
            severity: "CRITICAL",
            location: "src/auth.ts:12",
            rule: "Secret Logging",
            details: "token leaked to logger",
          },
          {
            severity: "HIGH",
            location: "src/db.ts:50",
            rule: "SQL Injection",
            details: "unparameterized query",
          },
        ]);
        expect(hasAnsi(table)).toBe(false);
        expect(table).toContain("CRITICAL");
        expect(table).toContain("HIGH");
      });

      it("formatTuiScanSummary contains no ANSI escape codes", () => {
        const cleanSummary = formatTuiScanSummary([]);
        expect(hasAnsi(cleanSummary)).toBe(false);

        const violationsSummary = formatTuiScanSummary(
          [
            {
              path: "src/key.ts",
              violations: [
                { line: 5, text: "console.log(key)", reason: "api key", severity: "HIGH" },
              ],
            },
          ],
          [
            {
              type: "Hardcoded Secret",
              severity: "CRITICAL",
              description: "API key hardcoded",
              fileLocation: "src/key.ts",
              codeSnippet: "const apiKey = 'secret';",
              lineStart: 5,
            },
          ],
        );
        expect(hasAnsi(violationsSummary)).toBe(false);
      });

      it("formatInitGreeting contains no ANSI escape codes", () => {
        const greeting = formatInitGreeting({
          success: true,
          message: "Hook created",
          hookPath: ".husky/pre-commit",
        });
        expect(hasAnsi(greeting)).toBe(false);
      });

      it("TerminalSpinner outputs no ANSI escape codes when color is disabled on non-TTY stream", () => {
        let output = "";
        const mockStream = {
          isTTY: false,
          write: (chunk: string) => {
            output += chunk;
          },
        } as any;

        const spinner = new TerminalSpinner("Inspecting", mockStream);
        spinner.start();
        spinner.succeed("Completed");
        spinner.warn("Warning");
        spinner.fail("Failed");

        expect(hasAnsi(output)).toBe(false);
      });
    });

    describe("ANSI escape codes appear when color is enabled in interactive terminal or forced", () => {
      beforeEach(() => {
        setColorEnabled(true);
      });

      it("colors methods include ANSI escape codes", () => {
        expect(hasAnsi(colors.red("sample text"))).toBe(true);
        expect(hasAnsi(colors.bold("heading"))).toBe(true);
        expect(hasAnsi(colors.bgRed("danger"))).toBe(true);
      });

      it("stripAnsi removes all ANSI escapes and restores plain text", () => {
        const colored = colors.red("hello world");
        expect(hasAnsi(colored)).toBe(true);
        expect(stripAnsi(colored)).toBe("hello world");
      });

      it("formatTuiScanSummary includes ANSI escapes when color is enabled", () => {
        const summary = formatTuiScanSummary([
          {
            path: "src/key.ts",
            violations: [
              { line: 5, text: "console.log(key)", reason: "api key", severity: "HIGH" },
            ],
          },
        ]);
        expect(hasAnsi(summary)).toBe(true);
      });
    });
  });

  describe("renderWarningTable", () => {
    it("returns empty string when given zero rows", () => {
      expect(renderWarningTable([])).toBe("");
    });

    it("renders formatted table with borders and headers", () => {
      const rows: TableRow[] = [
        {
          severity: "CRITICAL",
          location: "src/auth.ts:42",
          rule: "Secret Logging",
          details: "API key passed to console.log",
        },
        {
          severity: "HIGH",
          location: "contracts/Vault.sol:15",
          rule: "Reentrancy",
          details: "State variable updated after external call",
        },
      ];

      const output = renderWarningTable(rows);
      expect(output).toContain("SEVERITY");
      expect(output).toContain("LOCATION");
      expect(output).toContain("src/auth.ts:42");
      expect(output).toContain("contracts/Vault.sol:15");
      expect(output).toContain("┌");
      expect(output).toContain("└");
    });
  });

  describe("formatTuiScanSummary", () => {
    it("returns clean message when no findings are detected", () => {
      const summary = formatTuiScanSummary([]);
      expect(summary).toContain("No security violations");
    });

    it("aggregates file violations and AI findings into structured table summary", () => {
      const summary = formatTuiScanSummary(
        [
          {
            path: "src/api.ts",
            violations: [
              {
                line: 12,
                text: "console.log(token)",
                reason: "credential logging",
                severity: "CRITICAL",
              },
            ],
          },
        ],
        [
          {
            type: "SQL_INJECTION",
            severity: "HIGH",
            fileLocation: "src/db.ts",
            lineStart: 45,
            description: "Unsanitized user input in query",
            codeSnippet: "db.query(input)",
          },
        ],
      );

      expect(summary).toContain("Detected 2 security violation(s)");
      expect(summary).toContain("src/api.ts:12");
      expect(summary).toContain("src/db.ts:45");
      expect(summary).toContain("SQL_INJECTION");
    });
  });

  describe("TerminalSpinner", () => {
    it("initializes and handles start, update, and stop transitions", () => {
      let written = "";
      const mockStream = {
        isTTY: false,
        write: (chunk: string) => {
          written += chunk;
        },
      } as any;

      const spinner = new TerminalSpinner("Scanning staged files", mockStream);
      spinner.start();
      expect(written).toContain("Scanning staged files");

      spinner.update("Evaluating AI models");
      expect(written).toContain("Evaluating AI models");

      spinner.succeed("Scan complete");
      expect(written).toContain("Scan complete");
    });

    it("outputs warning and failure states correctly", () => {
      let written = "";
      const mockStream = {
        isTTY: false,
        write: (chunk: string) => {
          written += chunk;
        },
      } as any;

      const spinner = new TerminalSpinner("Testing warnings", mockStream);
      spinner.start();
      spinner.warn("Warning detected");
      expect(written).toContain("Warning detected");

      spinner.fail("Scan failed");
      expect(written).toContain("Scan failed");
    });
  });

  describe("initHuskyPreCommitHook", () => {
    let tempDir: string;

    beforeEach(() => {
      execSyncMock.mockReset();
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-husky-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates .husky/pre-commit with secureflow command when none exists", () => {
      const res = initHuskyPreCommitHook(tempDir);
      expect(res.success).toBe(true);
      expect(fs.existsSync(res.hookPath)).toBe(true);

      const content = fs.readFileSync(res.hookPath, "utf-8");
      expect(content).toContain("npx secureflow");
    });

    it("appends secureflow command to existing hook if not already present", () => {
      const huskyDir = path.join(tempDir, ".husky");
      fs.mkdirSync(huskyDir, { recursive: true });
      const hookPath = path.join(huskyDir, "pre-commit");
      fs.writeFileSync(hookPath, "npm test\n");

      const res = initHuskyPreCommitHook(tempDir);
      expect(res.success).toBe(true);

      const content = fs.readFileSync(hookPath, "utf-8");
      expect(content).toContain("npm test");
      expect(content).toContain("npx secureflow");
    });

    it("recognizes when secureflow is already configured and avoids duplicates", () => {
      const huskyDir = path.join(tempDir, ".husky");
      fs.mkdirSync(huskyDir, { recursive: true });
      const hookPath = path.join(huskyDir, "pre-commit");
      fs.writeFileSync(hookPath, "npx secureflow\n");

      const res = initHuskyPreCommitHook(tempDir);
      expect(res.success).toBe(true);
      expect(res.message).toContain("already configured");
    });

    it("runs npm init --y when package.json does not exist, runs npx husky init, and updates pre-commit (#1731)", () => {
      const commandsExecuted: string[] = [];
      const mockExec = vi.fn((cmd: string) => {
        commandsExecuted.push(cmd);
        if (cmd === "npx husky init") {
          // Simulate husky init creating .husky/pre-commit with default npm test
          const huskyDir = path.join(tempDir, ".husky");
          if (!fs.existsSync(huskyDir)) fs.mkdirSync(huskyDir, { recursive: true });
          fs.writeFileSync(path.join(huskyDir, "pre-commit"), "npm test\n", { mode: 0o755 });
        }
      });

      const res = initHuskyPreCommitHook(tempDir, mockExec);

      expect(res.success).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        "npm init --y",
        expect.objectContaining({ cwd: tempDir }),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "npx husky init",
        expect.objectContaining({ cwd: tempDir }),
      );
      expect(commandsExecuted).toEqual(["npm init --y", "npx husky init"]);

      const hookContent = fs.readFileSync(res.hookPath, "utf-8");
      expect(hookContent).toContain("npm test");
      expect(hookContent).toContain("npx secureflow");
    });

    it("skips npm init --y when package.json already exists (#1731)", () => {
      const pkgPath = path.join(tempDir, "package.json");
      fs.writeFileSync(pkgPath, JSON.stringify({ name: "existing-pkg" }));

      const commandsExecuted: string[] = [];
      const mockExec = vi.fn((cmd: string) => {
        commandsExecuted.push(cmd);
      });

      const res = initHuskyPreCommitHook(tempDir, mockExec);

      expect(res.success).toBe(true);
      expect(commandsExecuted).not.toContain("npm init --y");
      expect(commandsExecuted).toContain("npx husky init");
      expect(fs.existsSync(res.hookPath)).toBe(true);
    });

    it("handles exec failure gracefully and ensures pre-commit hook is still created (#1731)", () => {
      const mockExec = vi.fn(() => {
        throw new Error("Command failed: npx not available");
      });

      const res = initHuskyPreCommitHook(tempDir, mockExec);

      expect(res.success).toBe(true);
      expect(fs.existsSync(res.hookPath)).toBe(true);
      const content = fs.readFileSync(res.hookPath, "utf-8");
      expect(content).toContain("npx secureflow");
    });
  });

  describe("formatInitGreeting (#1732)", () => {
    it("renders ASCII banner, subtitle, protections, and next steps for new installation", () => {
      const greeting = formatInitGreeting({
        success: true,
        message: "Successfully created .husky/pre-commit hook configured with SecureFlow audit",
        hookPath: ".husky/pre-commit",
      });

      // ASCII banner
      expect(greeting).toContain("____");
      expect(greeting).toContain("SecureFlow");
      expect(greeting).toContain("Zero-Config Git Pre-Commit Security Engine");
      expect(greeting).toContain("v3.1.0");

      // Status & Hook
      expect(greeting).toContain("[SecureFlow Init] Successfully created .husky/pre-commit hook");
      expect(greeting).toContain("Hook Location:");
      expect(greeting).toContain(".husky/pre-commit");
      expect(greeting).toContain("npx secureflow");

      // Active Protections
      expect(greeting).toContain("Active Protections");
      expect(greeting).toContain("Secret Detection");
      expect(greeting).toContain("AI Security Review");
      expect(greeting).toContain("Web3 Smart Contracts");
      expect(greeting).toContain("Threat Intelligence");

      // Next Steps
      expect(greeting).toContain("Next Steps:");
      expect(greeting).toContain("git add <files>");
      expect(greeting).toContain('git commit -m "feat: new feature"');
      expect(greeting).toContain("npx secureflow --help");

      // Footer
      expect(greeting).toContain("Documentation:");
      expect(greeting).toContain("https://github.com/GauravKarakoti/SecureFlow");
    });

    it("renders informational status when hook is already configured", () => {
      const greeting = formatInitGreeting({
        success: true,
        message: "SecureFlow is already configured in .husky/pre-commit hook",
        hookPath: "/workspace/.husky/pre-commit",
      });

      expect(greeting).toContain("ℹ️");
      expect(greeting).toContain(
        "[SecureFlow Init] SecureFlow is already configured in .husky/pre-commit hook",
      );
      expect(greeting).toContain("/workspace/.husky/pre-commit");
      expect(greeting).toContain("(active)");
    });

    it("renders troubleshooting guidance and error details on failure", () => {
      const greeting = formatInitGreeting({
        success: false,
        message: "Failed to configure husky pre-commit hook: EACCES permission denied",
        hookPath: "",
      });

      expect(greeting).toContain("❌");
      expect(greeting).toContain("Failed to configure husky pre-commit hook: EACCES");
      expect(greeting).toContain("Troubleshooting:");
      expect(greeting).toContain("Ensure you have write permissions");
    });

    it("supports custom version and repository URL options", () => {
      const greeting = formatInitGreeting(
        {
          success: true,
          message: "Created hook",
          hookPath: ".husky/pre-commit",
        },
        {
          version: "4.0.0-beta",
          repoUrl: "https://custom-repo.example.com/docs",
        },
      );

      expect(greeting).toContain("v4.0.0-beta");
      expect(greeting).toContain("https://custom-repo.example.com/docs");
    });
  });
  describe("initBlankPrepareScript (#1758)", () => {
    let tempDir: string;

    beforeEach(() => {
      execSyncMock.mockReset();
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-blank-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("runs npm init --y when package.json does not exist and adds prepare script", () => {
      const commandsExecuted: string[] = [];
      const mockExec = vi.fn((cmd: string) => {
        commandsExecuted.push(cmd);
        if (cmd === "npm init --y") {
          fs.writeFileSync(
            path.join(tempDir, "package.json"),
            JSON.stringify({ name: "new-pkg", version: "1.0.0" }, null, 2),
          );
        }
      });

      const res = initBlankPrepareScript(tempDir, mockExec);

      expect(res.success).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        "npm init --y",
        expect.objectContaining({ cwd: tempDir }),
      );
      expect(commandsExecuted).toEqual(["npm init --y"]);

      const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package.json"), "utf-8"));
      expect(pkg.scripts.prepare).toBe("npx secureflow");
      expect(res.message).toContain("Successfully added npx secureflow");
    });

    it("skips npm init --y when package.json already exists and adds prepare script", () => {
      const pkgPath = path.join(tempDir, "package.json");
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          { name: "existing-pkg", version: "1.0.0", scripts: { test: "vitest" } },
          null,
          2,
        ),
      );

      const mockExec = vi.fn();
      const res = initBlankPrepareScript(tempDir, mockExec);

      expect(res.success).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();

      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.scripts.test).toBe("vitest");
      expect(pkg.scripts.prepare).toBe("npx secureflow");
    });

    it("appends npx secureflow with && when a prepare script already exists (e.g. xyz && npx secureflow)", () => {
      const pkgPath = path.join(tempDir, "package.json");
      fs.writeFileSync(
        pkgPath,
        JSON.stringify({ name: "existing-pkg", scripts: { prepare: "xyz" } }, null, 2),
      );

      const res = initBlankPrepareScript(tempDir);

      expect(res.success).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.scripts.prepare).toBe("xyz && npx secureflow");
      expect(res.message).toContain("Appended npx secureflow to existing prepare script");
    });

    it("recognizes when secureflow is already present in prepare script and avoids duplication", () => {
      const pkgPath = path.join(tempDir, "package.json");
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          { name: "existing-pkg", scripts: { prepare: "npm run build && npx secureflow" } },
          null,
          2,
        ),
      );

      const res = initBlankPrepareScript(tempDir);

      expect(res.success).toBe(true);
      expect(res.message).toContain("already configured");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.scripts.prepare).toBe("npm run build && npx secureflow");
    });

    it("handles invalid package.json JSON syntax gracefully", () => {
      const pkgPath = path.join(tempDir, "package.json");
      fs.writeFileSync(pkgPath, "{ invalid json ... ");

      const res = initBlankPrepareScript(tempDir);

      expect(res.success).toBe(false);
      expect(res.message).toContain("Failed to parse package.json");
    });
  });

  describe("detectInitMode & promptInitChoice (#1758)", () => {
    it("detects blank mode from command line arguments", () => {
      expect(detectInitMode(["node", "cli", "--init", "blank"])).toBe("blank");
      expect(detectInitMode(["node", "cli", "--init=blank"])).toBe("blank");
      expect(detectInitMode(["node", "cli", "--blank"])).toBe("blank");
      expect(detectInitMode(["node", "cli", "-b"])).toBe("blank");
      expect(detectInitMode(["node", "cli", "--init", "2"])).toBe("blank");
    });

    it("detects husky mode from command line arguments", () => {
      expect(detectInitMode(["node", "cli", "--init", "husky"])).toBe("husky");
      expect(detectInitMode(["node", "cli", "--init=husky"])).toBe("husky");
      expect(detectInitMode(["node", "cli", "--husky"])).toBe("husky");
      expect(detectInitMode(["node", "cli", "--init", "1"])).toBe("husky");
    });

    it("returns null when no mode argument is provided with --init", () => {
      expect(detectInitMode(["node", "cli", "--init"])).toBeNull();
      expect(detectInitMode(["node", "cli"])).toBeNull();
    });

    it("promptInitChoice resolves to blank when user selects 2 or blank", async () => {
      const mockRl = {
        question: vi.fn((_prompt: string, cb: (ans: string) => void) => cb("2")),
        close: vi.fn(),
        on: vi.fn(),
      } as any;

      const choice = await promptInitChoice(mockRl, process.stdin, { write: vi.fn() } as any);
      expect(choice).toBe("blank");
    });

    it("promptInitChoice resolves to husky when user selects 1, husky, or presses Enter", async () => {
      const mockRl1 = {
        question: vi.fn((_prompt: string, cb: (ans: string) => void) => cb("husky")),
        close: vi.fn(),
        on: vi.fn(),
      } as any;

      const choice1 = await promptInitChoice(mockRl1, process.stdin, { write: vi.fn() } as any);
      expect(choice1).toBe("husky");

      const mockRl2 = {
        question: vi.fn((_prompt: string, cb: (ans: string) => void) => cb("")),
        close: vi.fn(),
        on: vi.fn(),
      } as any;

      const choice2 = await promptInitChoice(mockRl2, process.stdin, { write: vi.fn() } as any);
      expect(choice2).toBe("husky");
    });
  });

  describe("initSecureFlow orchestrator (#1758)", () => {
    let tempDir: string;

    beforeEach(() => {
      execSyncMock.mockReset();
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-init-orch-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("routes to Blank mode when mode is specified as blank", async () => {
      const pkgPath = path.join(tempDir, "package.json");
      fs.writeFileSync(pkgPath, JSON.stringify({ name: "orch-test", scripts: {} }));

      const res = await initSecureFlow({
        mode: "blank",
        targetDir: tempDir,
      });

      expect(res.success).toBe(true);
      expect(res.hookPath).toBe(pkgPath);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.scripts.prepare).toBe("npx secureflow");
    });

    it("routes to Husky mode when mode is specified as husky", async () => {
      const res = await initSecureFlow({
        mode: "husky",
        targetDir: tempDir,
      });

      expect(res.success).toBe(true);
      expect(res.hookPath).toBe(path.join(tempDir, ".husky", "pre-commit"));
      expect(fs.existsSync(res.hookPath)).toBe(true);
    });

    it("formats greeting with package.json prepare script details in blank mode", () => {
      const greeting = formatInitGreeting({
        success: true,
        message: "Successfully added npx secureflow to package.json prepare script",
        hookPath: path.join(tempDir, "package.json"),
      });

      expect(greeting).toContain("Hook Location:");
      expect(greeting).toContain("package.json");
      expect(greeting).toContain("npm run prepare");
    });
  });
});
