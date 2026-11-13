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
  formatInitGreeting,
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
});
