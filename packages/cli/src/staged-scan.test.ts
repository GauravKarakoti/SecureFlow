import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import {
  getStagedDiffLineNumbers,
  getStagedFiles,
  readStagedContent,
  getGitHooksDir,
} from "./git.js";
import { installHook, uninstallHook, HOOK_MARKER } from "./hook.js";

const CLI_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.resolve(CLI_DIR, "dist/index.js");

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function initGitRepo(dir: string): void {
  runGit(["init"], dir);
  runGit(["config", "user.name", "Test Committer"], dir);
  runGit(["config", "user.email", "committer@secureflow.io"], dir);
}

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [BIN_PATH, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

describe("Staged Diff Scanning and Git Hook Integration (#2020)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-staged-scan-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("getStagedDiffLineNumbers", () => {
    it("extracts exact line numbers added in staged diff", () => {
      initGitRepo(tempDir);
      const file = path.join(tempDir, "sample.ts");

      // Initial commit with 5 lines
      fs.writeFileSync(file, "line1\nline2\nline3\nline4\nline5\n");
      runGit(["add", "sample.ts"], tempDir);
      runGit(["commit", "-m", "initial commit"], tempDir);

      // Modify line 3 and append line 6
      fs.writeFileSync(file, "line1\nline2\nline3-modified\nline4\nline5\nline6-new\n");
      runGit(["add", "sample.ts"], tempDir);

      const stagedLines = getStagedDiffLineNumbers("sample.ts", tempDir);
      expect(stagedLines.has(3)).toBe(true);
      expect(stagedLines.has(6)).toBe(true);
      expect(stagedLines.has(1)).toBe(false);
      expect(stagedLines.has(2)).toBe(false);
      expect(stagedLines.has(4)).toBe(false);
      expect(stagedLines.has(5)).toBe(false);
    });

    it("returns all lines for newly created staged files", () => {
      initGitRepo(tempDir);
      const file = path.join(tempDir, "newfile.ts");
      fs.writeFileSync(file, "line1\nline2\nline3\n");
      runGit(["add", "newfile.ts"], tempDir);

      const stagedLines = getStagedDiffLineNumbers("newfile.ts", tempDir);
      expect(stagedLines.size).toBe(3);
      expect(stagedLines.has(1)).toBe(true);
      expect(stagedLines.has(2)).toBe(true);
      expect(stagedLines.has(3)).toBe(true);
    });
  });

  describe("secureflow scan --staged CLI execution", () => {
    it("passes with exit code 0 when no files are staged", () => {
      initGitRepo(tempDir);

      const res = runCli(["scan", "--staged"], tempDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("✅ SecureFlow scan passed (0 staged file(s))");
    });

    it("passes with exit code 0 when staged changes contain no secrets", () => {
      initGitRepo(tempDir);
      const file = path.join(tempDir, "clean.ts");
      fs.writeFileSync(file, "export const value = 42;\nconsole.log(value);\n");
      runGit(["add", "clean.ts"], tempDir);

      const res = runCli(["scan", "--staged"], tempDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("✅ SecureFlow scan passed (1 staged file(s))");
    });

    it("blocks commit and exits non-zero (1) when a secret is staged", () => {
      initGitRepo(tempDir);
      const file = path.join(tempDir, "secret.ts");
      fs.writeFileSync(file, "console.log(process.env.AWS_SECRET_ACCESS_KEY);\n");
      runGit(["add", "secret.ts"], tempDir);

      const res = runCli(["scan", "--staged"], tempDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("❌ SecureFlow blocked this commit");
      expect(res.stderr).toContain("secret-logging violation");
    });

    it("scans only the staged diff: ignores legacy secrets on untouched lines in modified files", () => {
      initGitRepo(tempDir);
      const file = path.join(tempDir, "legacy.ts");

      // Commit legacy file with old secret
      fs.writeFileSync(
        file,
        'const key = process.env.AWS_SECRET_ACCESS_KEY;\nconsole.log("Old key:", key);\nconst safe = 100;\n',
      );
      runGit(["add", "legacy.ts"], tempDir);
      runGit(["commit", "-m", "legacy commit", "--no-verify"], tempDir);

      // Now developer edits only line 3 (the safe variable), leaving old lines untouched
      fs.writeFileSync(
        file,
        'const key = process.env.AWS_SECRET_ACCESS_KEY;\nconsole.log("Old key:", key);\nconst safe = 200;\n',
      );
      runGit(["add", "legacy.ts"], tempDir);

      // In --staged diff mode, only line 3 was added/modified, so old line 2 violation is not blocked
      const res = runCli(["scan", "--staged"], tempDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("✅ SecureFlow scan passed (1 staged file(s))");
    });

    it("keeps the full result in the cache so a later full scan still sees old secrets (#2194)", () => {
      initGitRepo(tempDir);
      const file = path.join(tempDir, "legacy.js");

      fs.writeFileSync(file, "console.log(process.env.DB_PASSWORD);\nconst a = 1;\n");
      runGit(["add", "legacy.js"], tempDir);
      runGit(["commit", "-m", "legacy commit", "--no-verify"], tempDir);

      // Stage an edit that leaves the offending line 1 untouched
      fs.appendFileSync(file, "const b = 2;\n");
      runGit(["add", "legacy.js"], tempDir);

      const stagedRes = runCli(["scan", "--staged"], tempDir);
      expect(stagedRes.status).toBe(0);
      expect(stagedRes.stdout).toContain("Analyzed 1 file(s) (0 cached)");

      const fullRes = runCli(["scan", ".", "--local", "--format", "json"], tempDir);
      expect(fullRes.status).toBe(1);
      const report = JSON.parse(fullRes.stdout);
      expect(report).toEqual([
        expect.objectContaining({
          path: expect.stringContaining("legacy.js"),
          violations: [expect.objectContaining({ line: 1 })],
        }),
      ]);

      // Same content from the cache: staged mode still only blocks on changed lines
      const stagedAgain = runCli(["scan", "--staged"], tempDir);
      expect(stagedAgain.status).toBe(0);
      expect(stagedAgain.stdout).toContain("Analyzed 0 file(s) (1 cached)");
    });

    it("fails with clear error when running --staged outside a git repository", () => {
      const res = runCli(["scan", "--staged"], tempDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Not a git repository");
    });

    it("respects configured minimum severity threshold in .secureflow.json", () => {
      initGitRepo(tempDir);

      // Configure gate.blockOn = NONE in .secureflow.json
      fs.writeFileSync(
        path.join(tempDir, ".secureflow.json"),
        JSON.stringify({ gate: { blockOn: "NONE" } }, null, 2),
      );

      const file = path.join(tempDir, "secret.ts");
      fs.writeFileSync(file, "console.log(process.env.AWS_SECRET_ACCESS_KEY);\n");
      runGit(["add", "secret.ts", ".secureflow.json"], tempDir);

      // Since blockOn is NONE, the scan should warn but pass (exit 0)
      const res = runCli(["scan", "--staged"], tempDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow advisory warning");
      expect(res.stdout).toContain("Scan passing");
    });
  });

  describe("End-to-End pre-commit Hook Workflow", () => {
    it("hook install creates executable hook calling scan --staged and blocks commit on secrets", async () => {
      initGitRepo(tempDir);

      // Install hook
      const installRes = await installHook({ cwd: tempDir, force: true });
      expect(installRes.success).toBe(true);

      const hooksDir = getGitHooksDir(tempDir);
      const hookFile = path.join(hooksDir, "pre-commit");
      expect(fs.existsSync(hookFile)).toBe(true);
      const hookContent = fs.readFileSync(hookFile, "utf-8");
      expect(hookContent).toContain(HOOK_MARKER);
      expect(hookContent).toContain("scan --staged");

      // Stage a secret
      const badFile = path.join(tempDir, "bad.ts");
      fs.writeFileSync(badFile, "console.log(process.env.AWS_SECRET_ACCESS_KEY);\n");
      runGit(["add", "bad.ts"], tempDir);

      // The pre-commit hook runs `scan --staged` on staged changes:
      const badScanRes = runCli(["scan", "--staged"], tempDir);
      expect(badScanRes.status).toBe(1);
      expect(badScanRes.stderr).toContain("❌ SecureFlow blocked this commit");

      // Fix the secret and re-stage
      fs.writeFileSync(badFile, "console.log('clean safe log');\n");
      runGit(["add", "bad.ts"], tempDir);

      // Now `scan --staged` should pass cleanly
      const cleanScanRes = runCli(["scan", "--staged"], tempDir);
      expect(cleanScanRes.status).toBe(0);
      expect(cleanScanRes.stdout).toContain("✅ SecureFlow scan passed");

      // Uninstall hook
      const uninstallRes = await uninstallHook({ cwd: tempDir });
      expect(uninstallRes.success).toBe(true);
      expect(fs.existsSync(hookFile)).toBe(false);
    });
  });
});
