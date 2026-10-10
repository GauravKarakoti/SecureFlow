/**
 * End-to-End (E2E) Test Suite for SecureFlow CLI binary (#1245).
 *
 * Spawns the compiled CLI binary (dist/index.js) in real subshells against
 * dynamically generated git repositories, validating exit codes, CLI flags,
 * export formats, ignore handling, and developer experience (DX).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync("node", [BIN_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "true",
      LOCAL_AI_URL: "http://127.0.0.1:0", // Prevent accidental external calls
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

function initGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync('git config user.name "Test Runner"', { cwd: repoDir, stdio: "ignore" });
  execSync('git config user.email "test@secureflow.local"', { cwd: repoDir, stdio: "ignore" });
}

describe("CLI End-to-End (E2E) Test Suite (#1245)", () => {
  let tempBaseDir: string;

  beforeAll(() => {
    // 1. Ensure the binary is fresh before testing
    execSync("npm run build", { cwd: CLI_DIR, stdio: "ignore" });
    expect(fs.existsSync(BIN_PATH)).toBe(true);

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cli-e2e-"));
  });

  afterAll(() => {
    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {
        // Ignored on Windows file locks
      }
    }
  });

  describe("1. Help and CLI Usage Handling", () => {
    it("displays help message with --help and exits 0", () => {
      const res = runCli(["--help"], CLI_DIR);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow CLI - Security analysis tool for staged git files");
      expect(res.stdout).toContain("Usage:");
      expect(res.stdout).toContain("--format <format>");
      expect(res.stdout).toContain("--fail-on <level>");
    });

    it("displays help message with short -h flag and exits 0", () => {
      const res = runCli(["-h"], CLI_DIR);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow CLI - Security analysis tool for staged git files");
    });

    it("fails with exit code 1 when an invalid format is specified", () => {
      const repoDir = path.join(tempBaseDir, "invalid-format-repo");
      initGitRepo(repoDir);

      const res = runCli(["--format", "unsupported_format"], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Invalid --format");
    });

    it("fails with exit code 1 when --severity has invalid arguments", () => {
      const repoDir = path.join(tempBaseDir, "invalid-severity-repo");
      initGitRepo(repoDir);

      const res = runCli(["--severity=invalid_tier"], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Unknown severity");
    });

    it("fails with exit code 1 when executed outside of a git repository", () => {
      const nonGitDir = path.join(tempBaseDir, "non-git-dir");
      fs.mkdirSync(nonGitDir, { recursive: true });

      const res = runCli([], nonGitDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Git error");
    });
  });

  describe("2. Clean Repositories and Safe Commits", () => {
    it("passes with exit code 0 when no files are staged", () => {
      const repoDir = path.join(tempBaseDir, "clean-empty-repo");
      initGitRepo(repoDir);

      const res = runCli([], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed (0 staged file(s))");
    });

    it("passes with exit code 0 when safe code without secrets is staged", () => {
      const repoDir = path.join(tempBaseDir, "safe-code-repo");
      initGitRepo(repoDir);

      const safeFile = path.join(repoDir, "math.ts");
      fs.writeFileSync(safeFile, 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
      execSync("git add math.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed (1 staged file(s))");
    });

    it("ignores unstaged files with secrets when only clean files are staged", () => {
      const repoDir = path.join(tempBaseDir, "unstaged-leak-repo");
      initGitRepo(repoDir);

      // Staged safe file
      fs.writeFileSync(path.join(repoDir, "safe.ts"), 'console.log("Safe operational log");');
      execSync("git add safe.ts", { cwd: repoDir, stdio: "ignore" });

      // Unstaged dangerous file
      fs.writeFileSync(path.join(repoDir, "unsafe.ts"), 'console.log("LEAK", apiKey);');

      const res = runCli([], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed (1 staged file(s))");
    });
  });

  describe("3. Secret Detection and Exit Code Enforcement", () => {
    it("blocks commit with exit code 1 when secret logging is detected", () => {
      const repoDir = path.join(tempBaseDir, "secret-leak-repo");
      initGitRepo(repoDir);

      const leakedFile = path.join(repoDir, "auth.ts");
      fs.writeFileSync(
        leakedFile,
        'function login(authToken: string) {\n  console.log("User token:", authToken);\n}\n'
      );
      execSync("git add auth.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Secret logging detected in auth.ts:2");
      expect(res.stderr).toContain("SecureFlow blocked this commit");
    });

    it("catches secrets logged via template string interpolations", () => {
      const repoDir = path.join(tempBaseDir, "template-interpolation-repo");
      initGitRepo(repoDir);

      const leakedFile = path.join(repoDir, "session.ts");
      fs.writeFileSync(
        leakedFile,
        'function logSession(secretKey: string) {\n  console.error(`Session key: ${secretKey}`);\n}\n'
      );
      execSync("git add session.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Secret logging detected in session.ts:2");
      expect(res.stderr).toContain("passed to a console call");
    });

    it("catches multi-line and wrapped logger calls", () => {
      const repoDir = path.join(tempBaseDir, "multiline-call-repo");
      initGitRepo(repoDir);

      const leakedFile = path.join(repoDir, "client.ts");
      fs.writeFileSync(
        leakedFile,
        'function setup(clientSecret: string) {\n  console.warn(\n    "Client initialization",\n    clientSecret\n  );\n}\n'
      );
      execSync("git add client.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Secret logging detected in client.ts");
      expect(res.stderr).toContain("SecureFlow blocked this commit");
    });

    it("allows scanning multiple staged files and reports all violations", () => {
      const repoDir = path.join(tempBaseDir, "multi-violation-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "serviceA.ts"), 'console.log(apiSecret);');
      fs.writeFileSync(path.join(repoDir, "serviceB.ts"), 'console.info(privateKey);');
      execSync("git add serviceA.ts serviceB.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("serviceA.ts");
      expect(res.stderr).toContain("serviceB.ts");
      expect(res.stderr).toContain("2 secret-logging violations");
    });
  });

  describe("4. Ignore Rules & Configuration Handling", () => {
    it("respects .secureflowignore file and skips ignored files", () => {
      const repoDir = path.join(tempBaseDir, "default-ignore-repo");
      initGitRepo(repoDir);

      // Create .secureflowignore
      fs.writeFileSync(path.join(repoDir, ".secureflowignore"), "mock-fixtures/**\n");

      // Stage an ignored file containing secret identifier
      fs.mkdirSync(path.join(repoDir, "mock-fixtures"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, "mock-fixtures", "dummy.ts"),
        'console.log("Mock test key:", apiKey);'
      );
      execSync("git add .secureflowignore mock-fixtures/dummy.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed");
    });

    it("respects custom ignore file via --ignore-file flag", () => {
      const repoDir = path.join(tempBaseDir, "custom-ignore-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "custom.ignore"), "test-fixtures/**\n");

      fs.mkdirSync(path.join(repoDir, "test-fixtures"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, "test-fixtures", "data.ts"),
        'console.log("Fixture:", secretToken);'
      );
      execSync("git add custom.ignore test-fixtures/data.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli(["--ignore-file", "custom.ignore"], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed");
    });
  });

  describe("5. Formats and Artifact Exporting", () => {
    it("outputs valid JSON format to stdout with --format json", () => {
      const repoDir = path.join(tempBaseDir, "json-stdout-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "app.ts"), 'console.log("Secret:", accessKey);');
      execSync("git add app.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli(["--format", "json"], repoDir);
      expect(res.status).toBe(1);

      const parsed = JSON.parse(res.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].path).toBe("app.ts");
      expect(parsed[0].violations.length).toBeGreaterThan(0);
      expect(parsed[0].violations[0].reason).toContain("accessKey");
    });

    it("exports JSON report to file via -o / --output", () => {
      const repoDir = path.join(tempBaseDir, "json-file-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "app.ts"), 'console.log("Token:", authToken);');
      execSync("git add app.ts", { cwd: repoDir, stdio: "ignore" });

      const outputPath = path.join(repoDir, "report.json");
      const res = runCli(["--format", "json", "-o", outputPath], repoDir);
      expect(res.status).toBe(1);
      expect(fs.existsSync(outputPath)).toBe(true);

      const content = fs.readFileSync(outputPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed[0].path).toBe("app.ts");
      expect(res.stdout).toContain("Scan report exported in JSON format to");
    });

    it("outputs valid SARIF v2.1.0 report with --format sarif", () => {
      const repoDir = path.join(tempBaseDir, "sarif-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "api.ts"), 'console.log("API Key:", apiKey);');
      execSync("git add api.ts", { cwd: repoDir, stdio: "ignore" });

      const sarifFile = path.join(repoDir, "results.sarif");
      const res = runCli(["--format", "sarif", "-o", sarifFile], repoDir);
      expect(res.status).toBe(1);
      expect(fs.existsSync(sarifFile)).toBe(true);

      const sarifJson = JSON.parse(fs.readFileSync(sarifFile, "utf-8"));
      expect(sarifJson.version).toBe("2.1.0");
      expect(sarifJson.$schema).toContain("sarif-schema-2.1.0.json");
      expect(sarifJson.runs[0].results.length).toBeGreaterThan(0);
      expect(sarifJson.runs[0].results[0].ruleId).toBe("SEC001");
    });

    it("exports Markdown report with --format markdown", () => {
      const repoDir = path.join(tempBaseDir, "md-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "md-test.ts"), 'console.log(dbPassword);');
      execSync("git add md-test.ts", { cwd: repoDir, stdio: "ignore" });

      const mdFile = path.join(repoDir, "summary.md");
      const res = runCli(["--format", "markdown", "-o", mdFile], repoDir);
      expect(res.status).toBe(1);
      expect(fs.existsSync(mdFile)).toBe(true);

      const mdContent = fs.readFileSync(mdFile, "utf-8");
      expect(mdContent).toContain("# SecureFlow Security Scan Report");
      expect(mdContent).toContain("md-test.ts");
    });

    it("exports CSV report with --format csv", () => {
      const repoDir = path.join(tempBaseDir, "csv-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "csv-test.ts"), 'console.log(secretToken);');
      execSync("git add csv-test.ts", { cwd: repoDir, stdio: "ignore" });

      const csvFile = path.join(repoDir, "report.csv");
      const res = runCli(["--format", "csv", "-o", csvFile], repoDir);
      expect(res.status).toBe(1);
      expect(fs.existsSync(csvFile)).toBe(true);

      const csvContent = fs.readFileSync(csvFile, "utf-8");
      expect(csvContent).toContain("File,Line,Severity,Rule,Reason,Code");
      expect(csvContent).toContain("csv-test.ts");
    });

    it("exports HTML report with --format html", () => {
      const repoDir = path.join(tempBaseDir, "html-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "html-test.ts"), 'console.log(masterKey);');
      execSync("git add html-test.ts", { cwd: repoDir, stdio: "ignore" });

      const htmlFile = path.join(repoDir, "report.html");
      const res = runCli(["--format", "html", "-o", htmlFile], repoDir);
      expect(res.status).toBe(1);
      expect(fs.existsSync(htmlFile)).toBe(true);

      const htmlContent = fs.readFileSync(htmlFile, "utf-8");
      expect(htmlContent).toContain("<!DOCTYPE html>");
      expect(htmlContent).toContain("SecureFlow Security Scan Report");
      expect(htmlContent).toContain("html-test.ts");
    });

    it("supports --dry-run without creating files on disk", () => {
      const repoDir = path.join(tempBaseDir, "dry-run-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "dry.ts"), 'console.log(jwtSecret);');
      execSync("git add dry.ts", { cwd: repoDir, stdio: "ignore" });

      const targetReport = path.join(repoDir, "dry-report.json");
      const res = runCli(["--format", "json", "-o", targetReport, "--dry-run"], repoDir);
      expect(res.status).toBe(1);
      expect(fs.existsSync(targetReport)).toBe(false);
      expect(res.stdout).toContain("[DRY RUN] Would write to");
    });
  });

  describe("6. Fail-On Thresholds and Severity Filtering", () => {
    it("fails commit when findings match or exceed --fail-on high", () => {
      const repoDir = path.join(tempBaseDir, "fail-on-high-repo");
      initGitRepo(repoDir);

      // Secret logging defaults to HIGH severity
      fs.writeFileSync(path.join(repoDir, "high.ts"), 'console.log(jwtSecret);');
      execSync("git add high.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli(["--fail-on", "high"], repoDir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("SecureFlow blocked this commit");
    });

    it("passes with exit code 0 as advisory warning when findings are below --fail-on critical", () => {
      const repoDir = path.join(tempBaseDir, "fail-on-critical-repo");
      initGitRepo(repoDir);

      // Secret logging defaults to HIGH severity (below CRITICAL)
      fs.writeFileSync(path.join(repoDir, "advisory.ts"), 'console.log(jwtSecret);');
      execSync("git add advisory.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli(["--fail-on", "critical"], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow advisory warning");
      expect(res.stdout).toContain("below CRITICAL. Scan passing.");
    });

    it("filters output using --severity filter flag", () => {
      const repoDir = path.join(tempBaseDir, "severity-filter-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "test.ts"), 'console.log(secretKey);');
      execSync("git add test.ts", { cwd: repoDir, stdio: "ignore" });

      // Secret logging is HIGH, so filtering for LOW excludes it from report
      const res = runCli(["--format", "json", "--severity", "low"], repoDir);
      const parsed = JSON.parse(res.stdout);
      expect(parsed[0].violations.length).toBe(0);
    });
  });

  describe("7. Local Mode and Flag Resilience", () => {
    it("respects --local flag and runs scan without attempting external AI connection", () => {
      const repoDir = path.join(tempBaseDir, "local-mode-repo");
      initGitRepo(repoDir);

      fs.writeFileSync(path.join(repoDir, "local.ts"), 'const greeting = "Hello world";\n');
      execSync("git add local.ts", { cwd: repoDir, stdio: "ignore" });

      const res = runCli(["--local", "--verbose"], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed");
    });

    it("handles binary or unreadable staged files gracefully without crashing", () => {
      const repoDir = path.join(tempBaseDir, "binary-file-repo");
      initGitRepo(repoDir);

      // Create fake binary file with null bytes
      const binaryPath = path.join(repoDir, "image.bin");
      fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
      execSync("git add image.bin", { cwd: repoDir, stdio: "ignore" });

      const res = runCli([], repoDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("SecureFlow scan passed");
    });
  });
});
