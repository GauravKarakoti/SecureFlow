import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  checkNodeVersion,
  checkGitAvailability,
  checkConfigFile,
  checkAiReachability,
  runDiagnostics,
  formatDoctorReport,
  runDoctor,
  probeVram,
} from "./doctor.js";

describe("SecureFlow Doctor Diagnostic Suite (#2125)", () => {
  describe("Node.js Version Diagnostic", () => {
    it("passes when Node.js version is 20 or higher", () => {
      const res20 = checkNodeVersion("v20.11.0", 20);
      expect(res20.status).toBe("pass");
      expect(res20.message).toContain("meets requirement");

      const res22 = checkNodeVersion("v22.2.0", 20);
      expect(res22.status).toBe("pass");
    });

    it("fails with a one-line fix when Node.js version is below 20", () => {
      const res18 = checkNodeVersion("v18.19.0", 20);
      expect(res18.status).toBe("fail");
      expect(res18.message).toContain("unsupported");
      expect(res18.fix).toBeDefined();
      expect(res18.fix).toContain("nvm");

      const res16 = checkNodeVersion("v16.14.0", 20);
      expect(res16.status).toBe("fail");
    });
  });

  describe("Git Availability Diagnostic", () => {
    it("passes when git is installed and directory is a git repository", () => {
      const mockGit = vi.fn().mockReturnValue("git version 2.43.0\n");
      const mockIsRepo = vi.fn().mockReturnValue(true);
      const mockRepoRoot = vi.fn().mockReturnValue("/workspace/project");

      const res = checkGitAvailability(mockGit, mockIsRepo, mockRepoRoot);
      expect(res.status).toBe("pass");
      expect(res.message).toContain("git version 2.43.0");
      expect(res.message).toContain("/workspace/project");
    });

    it("warns when git is installed but directory is not a git repository", () => {
      const mockGit = vi.fn().mockReturnValue("git version 2.43.0\n");
      const mockIsRepo = vi.fn().mockReturnValue(false);

      const res = checkGitAvailability(mockGit, mockIsRepo);
      expect(res.status).toBe("warn");
      expect(res.message).toContain("not inside a git repository");
      expect(res.fix).toContain("git init");
    });

    it("fails when git is not installed or not in PATH", () => {
      const mockGit = vi.fn().mockImplementation(() => {
        throw new Error("Command 'git' not found");
      });

      const res = checkGitAvailability(mockGit);
      expect(res.status).toBe("fail");
      expect(res.message).toContain("not installed");
      expect(res.fix).toContain("https://git-scm.com");
    });
  });

  describe("Configuration File Diagnostic", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-doctor-test-"));
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("warns when configuration file does not exist (using default policies)", () => {
      const res = checkConfigFile(".secureflow.json", tempDir);
      expect(res.status).toBe("warn");
      expect(res.message).toContain("No .secureflow.json found");
      expect(res.fix).toContain("secureflow init");
    });

    it("passes when .secureflow.json exists and is valid", () => {
      const validConfig = {
        gate: {
          blockOn: "HIGH",
        },
      };
      fs.writeFileSync(path.join(tempDir, ".secureflow.json"), JSON.stringify(validConfig));

      const res = checkConfigFile(".secureflow.json", tempDir);
      expect(res.status).toBe("pass");
      expect(res.message).toContain("is valid");
    });

    it("fails with a helpful one-line fix when .secureflow.json has syntax errors", () => {
      fs.writeFileSync(path.join(tempDir, ".secureflow.json"), "{ invalid json: true, ");

      const res = checkConfigFile(".secureflow.json", tempDir);
      expect(res.status).toBe("fail");
      expect(res.message).toContain("Invalid JSON syntax");
      expect(res.fix).toContain("Fix the JSON syntax errors");
    });

    it("fails with a helpful one-line fix when .secureflow.json has schema validation errors", () => {
      const invalidSchema = {
        gate: {
          blockOn: "INVALID_SEVERITY_LEVEL",
        },
      };
      fs.writeFileSync(path.join(tempDir, ".secureflow.json"), JSON.stringify(invalidSchema));

      const res = checkConfigFile(".secureflow.json", tempDir);
      expect(res.status).toBe("fail");
      expect(res.message).toContain("Schema validation failed");
      expect(res.fix).toContain("secureflow validate");
    });
  });

  describe("AI Endpoint & Local Model Reachability Diagnostic", () => {
    it("never prints API keys or secrets in diagnostic reports", async () => {
      const secretKey = "gsk_secret_1234567890abcdef1234567890";
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await checkAiReachability({
        env: {
          GROQ_API_KEY: secretKey,
          AI_PROVIDER: "groq",
        },
        fetchFn: mockFetch as any,
      });

      expect(res.status).toBe("pass");
      expect(res.message).not.toContain(secretKey);
      expect(res.message).toContain("[REDACTED]");
      if (res.fix) {
        expect(res.fix).not.toContain(secretKey);
      }
    });

    it("warns when cloud provider is configured without an API key", async () => {
      const res = await checkAiReachability({
        env: {},
      });

      expect(res.status).toBe("warn");
      expect(res.message).toContain("No API key detected");
      expect(res.fix).toContain("--local");
    });

    it("fails when cloud endpoint is unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network connection timeout"));

      const res = await checkAiReachability({
        env: {
          GROQ_API_KEY: "test-key",
          AI_PROVIDER: "groq",
        },
        fetchFn: mockFetch as any,
      });

      expect(res.status).toBe("fail");
      expect(res.message).toContain("unreachable");
      expect(res.fix).toContain("Check internet connectivity");
    });

    it("passes and reports available VRAM when local model is reachable", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const mockVram = vi.fn().mockReturnValue({
        totalMb: 16384,
        freeMb: 12288,
        type: "NVIDIA RTX 4090",
      });

      const res = await checkAiReachability({
        argv: ["--local"],
        env: {
          LOCAL_AI_URL: "http://localhost:11434",
          LOCAL_AI_PROVIDER: "ollama",
        },
        fetchFn: mockFetch as any,
        vramProbe: mockVram,
      });

      expect(res.status).toBe("pass");
      expect(res.message).toContain("ollama");
      expect(res.message).toContain("reachable at http://localhost:11434");
      expect(res.message).toContain("12288 MB free");
      expect(res.message).toContain("NVIDIA RTX 4090");
    });

    it("fails when local model runner is offline/unreachable", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const mockVram = vi.fn().mockReturnValue({
        totalMb: 8192,
        freeMb: 4096,
        type: "System RAM",
      });

      const res = await checkAiReachability({
        argv: ["--local"],
        env: {
          LOCAL_AI_URL: "http://localhost:11434",
          LOCAL_AI_PROVIDER: "ollama",
        },
        fetchFn: mockFetch as any,
        vramProbe: mockVram,
      });

      expect(res.status).toBe("fail");
      expect(res.message).toContain("unreachable");
      expect(res.fix).toContain("ollama serve");
    });
  });

  describe("Independent Diagnostics Execution & Reporting", () => {
    it("reports all checks independently so one failure does not hide the others", async () => {
      const mockGit = vi.fn().mockImplementation(() => {
        throw new Error("Git missing");
      });
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });

      const report = await runDiagnostics({
        nodeVersion: "v18.0.0", // Fail
        gitCommand: mockGit, // Fail
        env: {
          GROQ_API_KEY: "secret",
        },
        fetchFn: mockFetch as any, // Pass
      });

      expect(report.checks).toHaveLength(4);
      expect(report.checks[0].status).toBe("fail"); // Node version
      expect(report.checks[1].status).toBe("fail"); // Git
      expect(report.failCount).toBeGreaterThanOrEqual(2);
      expect(report.success).toBe(false);
    });

    it("formats diagnostic report with check symbols, summaries, and fixes", () => {
      const report = {
        checks: [
          { name: "Node.js Version", status: "pass" as const, message: "v20.0.0 ok" },
          { name: "Configuration File", status: "warn" as const, message: "Missing", fix: "Run init" },
          { name: "AI Reachability", status: "fail" as const, message: "Offline", fix: "Start service" },
        ],
        passedCount: 1,
        warnCount: 1,
        failCount: 1,
        success: false,
      };

      const formatted = formatDoctorReport(report);
      expect(formatted).toContain("🩺 SecureFlow Doctor Diagnostic Report");
      expect(formatted).toContain("✅ [PASS] Node.js Version");
      expect(formatted).toContain("⚠️  [WARN] Configuration File");
      expect(formatted).toContain("💡 Fix: Run init");
      expect(formatted).toContain("❌ [FAIL] AI Reachability");
      expect(formatted).toContain("💡 Fix: Start service");
      expect(formatted).toContain("Summary: 1 passed, 1 warning(s), 1 failed.");
    });
  });

  describe("VRAM probe helper", () => {
    it("returns memory statistics with total and free megabytes", () => {
      const vram = probeVram();
      expect(vram).not.toBeNull();
      expect(typeof vram?.totalMb).toBe("number");
      expect(typeof vram?.freeMb).toBe("number");
      expect(vram?.totalMb).toBeGreaterThan(0);
    });
  });
});
