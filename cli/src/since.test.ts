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

describe("--since REF CLI Integration Tests", () => {
  let tempBaseDir: string;

  beforeAll(() => {
    // Ensure CLI binary is compiled
    if (!fs.existsSync(BIN_PATH)) {
      execSync("npm run build", { cwd: CLI_DIR, stdio: "ignore" });
    }
  }, 60000);

  afterEach(() => {
    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {
        // Ignored on Windows file locks
      }
    }
  });

  it("scans only added, modified, and renamed files compared to ref, skipping deleted and untouched files", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-since-test-"));
    initGitRepo(tempBaseDir);

    // Initial commit on main
    fs.writeFileSync(path.join(tempBaseDir, "untouched.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tempBaseDir, "to-modify.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(tempBaseDir, "to-delete.ts"), "export const c = 3;\n");
    fs.writeFileSync(path.join(tempBaseDir, "to-rename.ts"), "export const d = 4;\n");

    runGit(["add", "."], tempBaseDir);
    runGit(["commit", "--no-verify", "-m", '"initial commit"'], tempBaseDir);

    // Create and switch to feature branch
    runGit(["checkout", "-b", "feature-branch"], tempBaseDir);

    // 1. Add new clean file
    fs.writeFileSync(path.join(tempBaseDir, "added.ts"), "export const added = 5;\n");

    // 2. Modify existing file
    fs.writeFileSync(path.join(tempBaseDir, "to-modify.ts"), "export const b = 200;\n");

    // 3. Delete file
    runGit(["rm", "to-delete.ts"], tempBaseDir);

    // 4. Rename file
    runGit(["mv", "to-rename.ts", "renamed.ts"], tempBaseDir);

    // Commit changes to feature branch
    runGit(["add", "."], tempBaseDir);
    runGit(["commit", "--no-verify", "-m", '"feature branch changes"'], tempBaseDir);

    // Run CLI with --since main in json format to inspect files
    const res = runCli(["--since", "main", "--format", "json"], tempBaseDir);

    expect(res.status).toBe(0);
    const jsonOutput = JSON.parse(res.stdout);
    const scannedPaths = jsonOutput.map((r: { path: string }) => r.path).sort();

    // Only added, modified, and renamed files should appear
    expect(scannedPaths).toEqual(["added.ts", "renamed.ts", "to-modify.ts"]);
    // Deleted file and untouched file should NOT be in the results
    expect(scannedPaths).not.toContain("to-delete.ts");
    expect(scannedPaths).not.toContain("untouched.ts");
  });

  it("detects violations in changed files and shows correct count in text output", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-since-test-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "clean.ts"), "export const x = 1;\n");
    runGit(["add", "."], tempBaseDir);
    runGit(["commit", "--no-verify", "-m", '"initial commit"'], tempBaseDir);

    runGit(["checkout", "-b", "feat-leak"], tempBaseDir);

    // Add a file with secret logging violation and commit it
    fs.writeFileSync(
      path.join(tempBaseDir, "leak.ts"),
      'console.log("Secret key:", process.env.AWS_SECRET_ACCESS_KEY);\n',
    );
    runGit(["add", "."], tempBaseDir);
    runGit(["commit", "--no-verify", "-m", '"add secret leak"'], tempBaseDir);

    const res = runCli(["--since", "main"], tempBaseDir);

    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("leak.ts");
    expect(res.stdout + res.stderr).toContain("SecureFlow blocked this commit");
  });

  it("passes with correct mode summary when all changed files are clean", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-since-test-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "clean.ts"), "export const x = 1;\n");
    runGit(["add", "."], tempBaseDir);
    runGit(["commit", "--no-verify", "-m", '"initial"'], tempBaseDir);

    // Modify clean.ts in working tree
    fs.writeFileSync(path.join(tempBaseDir, "clean.ts"), "export const x = 2;\n");

    const res = runCli(["--since", "HEAD"], tempBaseDir);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("✅ SecureFlow scan passed (1 changed file(s) since HEAD).");
  });

  it("fails with a clear error when git reference does not exist", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-since-test-"));
    initGitRepo(tempBaseDir);

    fs.writeFileSync(path.join(tempBaseDir, "clean.ts"), "export const x = 1;\n");
    runGit(["add", "."], tempBaseDir);
    runGit(["commit", "--no-verify", "-m", '"initial"'], tempBaseDir);

    const res = runCli(["--since", "non-existent-ref-xyz"], tempBaseDir);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      '❌ [SecureFlow] Git reference "non-existent-ref-xyz" does not exist.',
    );
  });

  it("fails with a clear error when directory is not a git repository", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-since-test-"));
    // Note: Do NOT initialize git repository here

    const res = runCli(["--since", "main"], tempBaseDir);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("❌ [SecureFlow] Not a git repository (or git is not on PATH).");
  });

  it("fails with a clear error when --since is missing an argument", () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-since-test-"));
    initGitRepo(tempBaseDir);

    const res = runCli(["--since"], tempBaseDir);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      "❌ [SecureFlow] --since requires a git reference (e.g. --since origin/main)",
    );
  });
});
