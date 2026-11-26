import crypto from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  runDoctor,
  formatDoctorReport,
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

describe("secureflow doctor (#2100)", () => {
  it("passes all checks and exits 0 when all mocked dependencies are healthy", async () => {
    const deps = createPassingDeps();
    const report = await runDoctor(deps);

    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.pass).toBe(6);

    const formatted = formatDoctorReport(report);
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
    const formatted = formatDoctorReport(report);
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
              checks: "read", // needs write
              contents: "read",
              metadata: "read",
              // missing pull_requests:write
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
