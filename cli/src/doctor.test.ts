import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkNodeVersion,
  checkGitAvailability,
  checkConfigFile,
  checkAiReachability,
  runDiagnostics,
  formatDoctorReport,
  probeVram,
  runDoctor,
  formatServerDoctorReport,
  redactDoctorText,
  checkEnvironmentVariables,
  checkLlmKeys,
  type DoctorDependencies,
} from "./doctor.js";

const { privateKey: TEST_RSA_PRIVATE_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function fullValidEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://postgres:super_secret_db_pw@db.example.com:5432/secureflow",
    AUTH_SECRET: "auth_super_secret_token_value_123456",
    NEXT_PUBLIC_APP_URL: "https://secureflow.example.com",
    REDIS_URL: "redis://default:super_secret_redis_pw@redis.example.com:6379",
    GROQ_API_KEY: "gsk_super_secret_groq_key_1234567890abcdef",
    GITHUB_APP_ID: "123456",
    GITHUB_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: "whsec_super_secret_webhook_12345",
  };
}

function createPassingDeps(envOverrides: NodeJS.ProcessEnv = {}): DoctorDependencies {
  const env = { ...fullValidEnv(), ...envOverrides };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/app")) {
      return new Response(
        JSON.stringify({
          name: "SecureFlow App",
          permissions: {
            checks: "write",
            pull_requests: "write",
            contents: "read",
            metadata: "read",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/app/hook/config")) {
      return new Response(
        JSON.stringify({
          url: "https://secureflow.example.com/api/webhooks/github",
          content_type: "json",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;

  return {
    env,
    cwd: process.cwd(),
    checkDatabase: vi.fn(async () => ({ ok: true, detail: "Reachable at db.example.com:5432" })),
    checkMigrations: vi.fn(async () => ({
      status: "up-to-date" as const,
      detail: "All Prisma migrations are applied",
    })),
    checkRedis: vi.fn(async () => ({ ok: true, detail: "Redis responded to PING" })),
    fetchFn: fetchMock,
  };
}

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
        nodeVersion: "v18.0.0",
        gitCommand: mockGit,
        env: {
          GROQ_API_KEY: "secret",
        },
        fetchFn: mockFetch as any,
      });

      expect(report.checks).toHaveLength(4);
      expect(report.checks[0]!.status).toBe("fail");
      expect(report.checks[1]!.status).toBe("fail");
      expect(report.failCount).toBeGreaterThanOrEqual(2);
      expect(report.success).toBe(false);
    });

    it("formats diagnostic report with check symbols, summaries, and fixes", () => {
      const report = {
        checks: [
          { name: "Node.js Version", status: "pass" as const, message: "v20.0.0 ok" },
          {
            name: "Configuration File",
            status: "warn" as const,
            message: "Missing",
            fix: "Run init",
          },
          {
            name: "AI Reachability",
            status: "fail" as const,
            message: "Offline",
            fix: "Start service",
          },
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

describe("secureflow doctor (#2100)", () => {
  it("passes all checks and exits 0 when all mocked dependencies are healthy", async () => {
    const deps = createPassingDeps();
    const report = await runDoctor(deps);

    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.pass).toBe(6);

    const formatted = formatServerDoctorReport(report);
    expect(formatted).toContain("[PASS] Environment variables");
    expect(formatted).toContain("[PASS] Database connectivity");
    expect(formatted).toContain("[PASS] Database migrations");
    expect(formatted).toContain("[PASS] Redis connectivity");
    expect(formatted).toContain("[PASS] LLM provider key / endpoint");
    expect(formatted).toContain("[PASS] GitHub App permissions & webhook");
  });

  it("never leaks secrets in formatted output or JSON report, even if an error includes credentials", async () => {
    const env = fullValidEnv();
    const deps: DoctorDependencies = {
      ...createPassingDeps(),
      env,
      checkDatabase: vi.fn(async () => {
        throw new Error(
          `Connection refused for ${env.DATABASE_URL} with key ${env.GROQ_API_KEY}`,
        );
      }),
      checkRedis: vi.fn(async () => {
        throw new Error(`ECONNREFUSED ${env.REDIS_URL}`);
      }),
    };

    const report = await runDoctor(deps);
    const formatted = formatServerDoctorReport(report);
    const serialized = JSON.stringify(report);

    for (const secret of [
      "super_secret_db_pw",
      "super_secret_redis_pw",
      "auth_super_secret_token_value_123456",
      "gsk_super_secret_groq_key_1234567890abcdef",
      "whsec_super_secret_webhook_12345",
      "BEGIN PRIVATE KEY",
      "BEGIN RSA PRIVATE KEY",
    ]) {
      expect(formatted).not.toContain(secret);
      expect(serialized).not.toContain(secret);
    }
    expect(formatted).toContain("[REDACTED]");
  });

  it("reports fail and exits non-zero when required environment variables are missing", async () => {
    const deps = createPassingDeps({
      DATABASE_URL: undefined,
      AUTH_SECRET: undefined,
      NEXTAUTH_SECRET: undefined,
    });

    const report = await runDoctor(deps);
    expect(report.exitCode).toBe(1);
    const envCheck = report.checks.find((c) => c.id === "env");
    expect(envCheck?.status).toBe("fail");
    expect(envCheck?.message).toContain("DATABASE_URL");
    expect(envCheck?.fix).toContain("Set DATABASE_URL, AUTH_SECRET");
  });

  it("reports fail with fix suggestion when database is unreachable or migrations are pending", async () => {
    const deps: DoctorDependencies = {
      ...createPassingDeps(),
      checkDatabase: vi.fn(async () => ({ ok: false, detail: "Connection timed out" })),
      checkMigrations: vi.fn(async () => ({
        status: "pending" as const,
        detail: "2 pending migrations",
      })),
    };

    const report = await runDoctor(deps);
    expect(report.exitCode).toBe(1);

    const dbCheck = report.checks.find((c) => c.id === "database");
    expect(dbCheck?.status).toBe("fail");
    expect(dbCheck?.fix).toBeTruthy();

    const migCheck = report.checks.find((c) => c.id === "migrations");
    expect(migCheck?.status).toBe("fail");
    expect(migCheck?.fix).toContain("prisma migrate deploy");
  });

  it("reports warn (exit 0) when Redis and GitHub App credentials are not configured", async () => {
    const deps = createPassingDeps({
      REDIS_URL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      GITHUB_APP_ID: undefined,
      GITHUB_PRIVATE_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: undefined,
    });

    const report = await runDoctor(deps);
    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBeGreaterThanOrEqual(2);

    const redisCheck = report.checks.find((c) => c.id === "redis");
    expect(redisCheck?.status).toBe("warn");
    expect(redisCheck?.fix).toContain("REDIS_URL");

    const ghCheck = report.checks.find((c) => c.id === "github-app");
    expect(ghCheck?.status).toBe("warn");
    expect(ghCheck?.fix).toContain("GITHUB_APP_ID");
  });

  it("supports Upstash Redis REST check via mocked fetch", async () => {
    const baseDeps = createPassingDeps({
      REDIS_URL: undefined,
      UPSTASH_REDIS_REST_URL: "https://redis.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "upstash_secret_token_123456",
    });

    const originalFetch = baseDeps.fetchFn!;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://redis.upstash.io/ping") {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe(
          "Bearer upstash_secret_token_123456",
        );
        return new Response(JSON.stringify({ result: "PONG" }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;

    const report = await runDoctor({ ...baseDeps, fetchFn: fetchMock });
    const redisCheck = report.checks.find((c) => c.id === "redis");
    expect(redisCheck?.status).toBe("pass");
    expect(JSON.stringify(report)).not.toContain("upstash_secret_token_123456");
  });

  it("fails when GitHub App lacks required permissions or has no webhook URL", async () => {
    const baseDeps = createPassingDeps();
    const fetchMissingPerms = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/app")) {
        return new Response(
          JSON.stringify({
            permissions: {
              checks: "read",
              contents: "read",
              metadata: "read",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ url: "" }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await runDoctor({ ...baseDeps, fetchFn: fetchMissingPerms });
    expect(report.exitCode).toBe(1);
    const ghCheck = report.checks.find((c) => c.id === "github-app");
    expect(ghCheck?.status).toBe("fail");
    expect(ghCheck?.message).toContain("checks:write");
    expect(ghCheck?.message).toContain("pull_requests:write");
    expect(ghCheck?.fix).toContain("GitHub App Settings");
  });

  it("detects placeholder LLM keys as missing", () => {
    const res = checkLlmKeys({ GROQ_API_KEY: "gsk_your_actual_api_key_here" });
    expect(res.status).toBe("fail");
    expect(res.fix).toContain("GROQ_API_KEY");
  });

  it("validates checkEnvironmentVariables placeholder detection", () => {
    const res = checkEnvironmentVariables({
      DATABASE_URL: "postgresql://neondb_owner:<Password>@host/db",
      AUTH_SECRET: "your_random_secret_here",
    });
    expect(res.status).toBe("fail");
    expect(res.message).toContain("DATABASE_URL");
    expect(res.message).toContain("AUTH_SECRET");
  });

  it("redactDoctorText masks URL passwords and env secrets", () => {
    const env = {
      DATABASE_URL: "postgres://admin:s3cr3tPass@db.internal:5432/app",
      GROQ_API_KEY: "gsk_real_key_987654321",
    };
    const out = redactDoctorText(
      "Failed connecting to postgres://admin:s3cr3tPass@db.internal:5432/app with gsk_real_key_987654321",
      env,
    );
    expect(out).not.toContain("s3cr3tPass");
    expect(out).not.toContain("gsk_real_key_987654321");
    expect(out).toContain("[REDACTED]");
  });
});