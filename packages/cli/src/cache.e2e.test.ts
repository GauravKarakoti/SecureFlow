import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CLI_DIR = path.resolve(__dirname, "..");
const BIN_PATH = path.resolve(CLI_DIR, "dist/index.js");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): RunResult {
  const result = spawnSync("node", [BIN_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "true",
      LOCAL_AI_URL: "http://127.0.0.1:0", // Prevent external calls
      ...env,
    },
    timeout: 30000,
  });

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runGit(args: string[], cwd: string): string {
  return execSync(`git -c core.hooksPath="" ${args.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(["init", "-b", "main"], repoDir);
  runGit(["config", "user.name", '"Test Runner"'], repoDir);
  runGit(["config", "user.email", '"test@secureflow.local"'], repoDir);
  runGit(["config", "commit.gpgsign", "false"], repoDir);
}

describe("CLI Cache E2E Integration Tests", () => {
  let tempBaseDir: string;

  beforeAll(() => {
    if (!fs.existsSync(BIN_PATH)) {
      execSync("npm run build", { cwd: CLI_DIR, stdio: "ignore" });
    }
  }, 60000);

  afterEach(() => {
    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  it("first scan analyzes all files; second scan of unchanged repo analyzes 0 files", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-e2e-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "fileA.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tempBaseDir, "fileB.ts"), "export const b = 2;\n");
    runGit(["add", "fileA.ts", "fileB.ts"], tempBaseDir);

    // 1. Initial scan: cold cache -> analyzes 2 files
    const res1 = runCli([], tempBaseDir);
    expect(res1.status).toBe(0);
    expect(res1.stdout).toContain("Analyzed 2 file(s) (0 cached)");
    expect(res1.stdout).toContain("SecureFlow scan passed (2 staged file(s))");

    // 2. Second scan of unchanged repo: warm cache -> analyzes 0 files
    const res2 = runCli([], tempBaseDir);
    expect(res2.status).toBe(0);
    expect(res2.stdout).toContain("Analyzed 0 file(s) (2 cached)");
    expect(res2.stdout).toContain("SecureFlow scan passed (2 staged file(s))");
  });

  it("modifying a file re-analyzes only the modified file", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-e2e-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "fileA.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tempBaseDir, "fileB.ts"), "export const b = 2;\n");
    runGit(["add", "fileA.ts", "fileB.ts"], tempBaseDir);

    // Initial scan
    runCli([], tempBaseDir);

    // Modify fileB.ts
    fs.writeFileSync(path.join(tempBaseDir, "fileB.ts"), "export const b = 'MODIFIED';\n");
    runGit(["add", "fileB.ts"], tempBaseDir);

    const res = runCli([], tempBaseDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Analyzed 1 file(s) (1 cached)");
  });

  it("--no-cache forces fresh analysis of all files", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-e2e-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "fileA.ts"), "export const a = 1;\n");
    runGit(["add", "fileA.ts"], tempBaseDir);

    // Initial scan to populate cache
    runCli([], tempBaseDir);

    // Run with --no-cache
    const res = runCli(["--no-cache"], tempBaseDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Analyzed 1 file(s) (0 cached)");
  });

  it("secureflow cache-clear removes cache entries and allows clean repeat scan", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-e2e-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "fileA.ts"), "export const a = 1;\n");
    runGit(["add", "fileA.ts"], tempBaseDir);

    // Populate cache
    runCli([], tempBaseDir);

    // Clear cache
    const clearRes = runCli(["cache-clear"], tempBaseDir);
    expect(clearRes.status).toBe(0);
    expect(clearRes.stdout).toContain("Cache cleared successfully");

    // Subsequent scan re-analyzes all files
    const res = runCli([], tempBaseDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Analyzed 1 file(s) (0 cached)");
  });

  it("gracefully recovers from corrupt cache files without crashing", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cache-e2e-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "fileA.ts"), "export const a = 1;\n");
    runGit(["add", "fileA.ts"], tempBaseDir);

    // Create a corrupt cache directory entry
    const cacheDir = path.join(tempBaseDir, ".secureflow", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    // Write invalid JSON file
    fs.writeFileSync(path.join(cacheDir, "any-hash.json"), "{ invalid JSON content", "utf-8");

    // Scan should not crash and should succeed
    const res = runCli([], tempBaseDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("SecureFlow scan passed (1 staged file(s))");
  });
});
