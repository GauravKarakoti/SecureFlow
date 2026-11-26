/**
 * SecureFlow CLI Doctor (#2100)
 *
 * Diagnoses installation, configuration, and connectivity problems up front:
 * - Environment variables (required & recommended)
 * - Database connectivity
 * - Prisma migration status
 * - Redis connectivity (REDIS_URL or Upstash REST)
 * - LLM API key / local AI presence
 * - GitHub App permissions and webhook configuration (when credentials are available)
 *
 * Never prints secret values in output, error messages, or JSON reports.
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { Redis } from "ioredis";
import { maskSecrets, REDACTION_PLACEHOLDER } from "./secret-masker.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: DoctorStatus;
  message: string;
  fix: string;
}

export interface DoctorReport {
  checks: DoctorCheckResult[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  exitCode: number;
}

export interface DbCheckOutcome {
  ok: boolean;
  detail: string;
}

export interface MigrationCheckOutcome {
  status: "up-to-date" | "pending" | "failed" | "unknown";
  detail: string;
}

export interface RedisCheckOutcome {
  ok: boolean;
  detail: string;
}

export interface DoctorDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  checkTcp?: (host: string, port: number, timeoutMs?: number) => Promise<void>;
  checkDatabase?: (databaseUrl: string) => Promise<DbCheckOutcome>;
  checkMigrations?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<MigrationCheckOutcome>;
  checkRedis?: (redisUrl: string) => Promise<RedisCheckOutcome>;
  fetchFn?: typeof fetch;
}

const PLACEHOLDER_VALUES = new Set([
  "",
  "your_app_id",
  "your_webhook_secret",
  "your_random_secret_here",
  "your_oauth_app_client_id",
  "your_oauth_app_client_secret",
  "gsk_your_actual_api_key_here",
  "your_api_key",
  "your-api-key",
  "changeme",
  "replace_me",
]);

const SENSITIVE_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_POOL_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_SECRET",
  "ENCRYPTION_KEY",
  "ELEVENLABS_API_KEY",
  "BREVO_API_KEY",
  "SMTP_PASS",
  "ARMORIQ_API_KEY",
  "ARMORIQ_PROOF_SIGNING_KEY",
] as const;

const REQUIRED_GITHUB_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  checks: "write",
  pull_requests: "write",
  contents: "read",
  metadata: "read",
};

function isConfiguredValue(val: string | undefined): boolean {
  if (!val) return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return false;
  if (trimmed.includes("<Password>") || trimmed.includes("-----BEGIN RSA PRIVATE KEY-----\n...\n")) {
    return false;
  }
  return true;
}

/**
 * Redacts any sensitive environment values, URL credentials, private keys, or
 * high-entropy tokens from diagnostic text before it is printed.
 */
export function redactDoctorText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = text;

  // Mask user:password@ in connection strings (Postgres, Redis, HTTP, etc.)
  out = out.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/g,
    `$1${REDACTION_PLACEHOLDER}$3`,
  );

  // Mask known secret values from env if they appear verbatim
  for (const key of SENSITIVE_ENV_KEYS) {
    const raw = env[key];
    if (!raw || raw.trim().length < 6) continue;
    const trimmed = raw.trim();
    if (out.includes(trimmed)) {
      out = out.split(trimmed).join(REDACTION_PLACEHOLDER);
    }
    // Also redact URL password portion if the env var is a URL
    try {
      const parsed = new URL(trimmed);
      if (parsed.password && parsed.password.length >= 4 && out.includes(parsed.password)) {
        out = out.split(parsed.password).join(REDACTION_PLACEHOLDER);
      }
    } catch {
      // Not a URL
    }
  }

  // Apply CLI secret-masker rules (API keys, JWTs, PEM headers, Bearer tokens)
  return maskSecrets(out);
}

async function defaultCheckTcp(host: string, port: number, timeoutMs = 3000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });

    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

async function defaultCheckDatabase(
  databaseUrl: string,
  checkTcp: (host: string, port: number, timeoutMs?: number) => Promise<void>,
): Promise<DbCheckOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, detail: "DATABASE_URL is not a valid URL" };
  }

  if (!parsed.hostname) {
    return { ok: false, detail: "DATABASE_URL is missing a hostname" };
  }

  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
  if (!Number.isFinite(port) || port <= 0) {
    return { ok: false, detail: "DATABASE_URL has an invalid port" };
  }

  await checkTcp(parsed.hostname, port, 3000);
  return { ok: true, detail: `Reachable at ${parsed.hostname}:${port}` };
}

async function defaultCheckMigrations(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<MigrationCheckOutcome> {
  const migrationsDir = path.join(cwd, "prisma", "migrations");
  if (!fs.existsSync(migrationsDir)) {
    return {
      status: "unknown",
      detail: "prisma/migrations directory not found in current workspace",
    };
  }

  try {
    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const { stdout, stderr } = await execFileAsync(
      npxCmd,
      ["prisma", "migrate", "status"],
      { cwd, env, timeout: 10000 },
    );
    const combined = `${stdout}\n${stderr}`;
    if (/Database schema is up to date/i.test(combined)) {
      return { status: "up-to-date", detail: "All Prisma migrations are applied" };
    }
    if (/Following migration\(s\) have not yet been applied/i.test(combined)) {
      return { status: "pending", detail: "Pending Prisma migrations detected" };
    }
    if (/failed migrations?/i.test(combined)) {
      return { status: "failed", detail: "Failed Prisma migration state detected" };
    }
    return { status: "unknown", detail: "Unable to determine Prisma migration status" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not yet been applied/i.test(msg)) {
      return { status: "pending", detail: "Pending Prisma migrations detected" };
    }
    if (/failed migrations?/i.test(msg)) {
      return { status: "failed", detail: "Failed Prisma migration state detected" };
    }
    return {
      status: "unknown",
      detail: `Could not run prisma migrate status: ${msg.split("\n")[0] ?? "unknown error"}`,
    };
  }
}

async function defaultCheckRedis(redisUrl: string): Promise<RedisCheckOutcome> {
  const client = new Redis(redisUrl, {
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong === "PONG") {
      return { ok: true, detail: "Redis responded to PING" };
    }
    return { ok: false, detail: `Unexpected Redis PING response: ${pong}` };
  } finally {
    client.disconnect();
  }
}

function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

export function createGitHubAppJwt(appId: string, privateKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSec - 60,
      exp: nowSec + 540,
      iss: appId,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizePrivateKey(privateKey)).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function checkEnvironmentVariables(env: NodeJS.ProcessEnv): DoctorCheckResult {
  const missingRequired: string[] = [];
  if (!isConfiguredValue(env.DATABASE_URL)) {
    missingRequired.push("DATABASE_URL");
  }
  if (!isConfiguredValue(env.AUTH_SECRET) && !isConfiguredValue(env.NEXTAUTH_SECRET)) {
    missingRequired.push("AUTH_SECRET");
  }

  const missingRecommended: string[] = [];
  if (!isConfiguredValue(env.NEXT_PUBLIC_APP_URL) && !isConfiguredValue(env.AUTH_URL)) {
    missingRecommended.push("NEXT_PUBLIC_APP_URL");
  }
  if (!isConfiguredValue(env.GITHUB_APP_ID)) {
    missingRecommended.push("GITHUB_APP_ID");
  }
  if (!isConfiguredValue(env.GITHUB_PRIVATE_KEY)) {
    missingRecommended.push("GITHUB_PRIVATE_KEY");
  }
  if (!isConfiguredValue(env.GITHUB_WEBHOOK_SECRET)) {
    missingRecommended.push("GITHUB_WEBHOOK_SECRET");
  }

  if (missingRequired.length > 0) {
    return {
      id: "env",
      name: "Environment variables",
      status: "fail",
      message: `Missing required environment variable(s): ${missingRequired.join(", ")}`,
      fix: `Set ${missingRequired.join(", ")} in .env or your runtime environment (see .env.example).`,
    };
  }

  if (missingRecommended.length > 0) {
    return {
      id: "env",
      name: "Environment variables",
      status: "warn",
      message: `Core variables set; missing recommended variable(s): ${missingRecommended.join(", ")}`,
      fix: `Configure ${missingRecommended.join(", ")} for full GitHub App and webhook support.`,
    };
  }

  return {
    id: "env",
    name: "Environment variables",
    status: "pass",
    message: "All required and recommended environment variables are set",
    fix: "No action needed.",
  };
}

export async function checkDatabaseConnectivity(
  env: NodeJS.ProcessEnv,
  deps: DoctorDependencies,
): Promise<DoctorCheckResult> {
  const dbUrl = env.DATABASE_URL;
  if (!isConfiguredValue(dbUrl)) {
    return {
      id: "database",
      name: "Database connectivity",
      status: "fail",
      message: "DATABASE_URL is not configured",
      fix: "Set DATABASE_URL to a reachable PostgreSQL connection string.",
    };
  }

  try {
    const checkTcp = deps.checkTcp ?? defaultCheckTcp;
    const outcome = deps.checkDatabase
      ? await deps.checkDatabase(dbUrl!)
      : await defaultCheckDatabase(dbUrl!, checkTcp);

    if (outcome.ok) {
      return {
        id: "database",
        name: "Database connectivity",
        status: "pass",
        message: redactDoctorText(outcome.detail, env),
        fix: "No action needed.",
      };
    }

    return {
      id: "database",
      name: "Database connectivity",
      status: "fail",
      message: redactDoctorText(outcome.detail, env),
      fix: "Verify DATABASE_URL host/port/credentials and ensure PostgreSQL is running.",
    };
  } catch (err) {
    const msg = redactDoctorText(err instanceof Error ? err.message : String(err), env);
    return {
      id: "database",
      name: "Database connectivity",
      status: "fail",
      message: `Database connection failed: ${msg}`,
      fix: "Ensure PostgreSQL is running, network/firewall allows access, and DATABASE_URL is correct.",
    };
  }
}

export async function checkMigrationStatus(
  env: NodeJS.ProcessEnv,
  cwd: string,
  deps: DoctorDependencies,
): Promise<DoctorCheckResult> {
  if (!isConfiguredValue(env.DATABASE_URL)) {
    return {
      id: "migrations",
      name: "Database migrations",
      status: "fail",
      message: "Cannot check migrations without DATABASE_URL",
      fix: "Set DATABASE_URL and run: npx prisma migrate deploy",
    };
  }

  try {
    const outcome = deps.checkMigrations
      ? await deps.checkMigrations(cwd, env)
      : await defaultCheckMigrations(cwd, env);

    const detail = redactDoctorText(outcome.detail, env);
    if (outcome.status === "up-to-date") {
      return {
        id: "migrations",
        name: "Database migrations",
        status: "pass",
        message: detail,
        fix: "No action needed.",
      };
    }
    if (outcome.status === "pending") {
      return {
        id: "migrations",
        name: "Database migrations",
        status: "fail",
        message: detail,
        fix: "Run: npx prisma migrate deploy",
      };
    }
    if (outcome.status === "failed") {
      return {
        id: "migrations",
        name: "Database migrations",
        status: "fail",
        message: detail,
        fix: "Inspect _prisma_migrations and resolve failed migrations with: npx prisma migrate resolve",
      };
    }
    return {
      id: "migrations",
      name: "Database migrations",
      status: "warn",
      message: detail,
      fix: "Run npx prisma migrate status from the project root to verify schema state.",
    };
  } catch (err) {
    const msg = redactDoctorText(err instanceof Error ? err.message : String(err), env);
    return {
      id: "migrations",
      name: "Database migrations",
      status: "warn",
      message: `Migration check inconclusive: ${msg}`,
      fix: "Run npx prisma migrate status from the project root to verify schema state.",
    };
  }
}

export async function checkRedisConnectivity(
  env: NodeJS.ProcessEnv,
  deps: DoctorDependencies,
): Promise<DoctorCheckResult> {
  const redisUrl = env.REDIS_URL;
  const upstashUrl = env.UPSTASH_REDIS_REST_URL;
  const upstashToken = env.UPSTASH_REDIS_REST_TOKEN;
  const fetchFn = deps.fetchFn ?? fetch;

  if (isConfiguredValue(redisUrl)) {
    try {
      const outcome = deps.checkRedis
        ? await deps.checkRedis(redisUrl!)
        : await defaultCheckRedis(redisUrl!);
      if (outcome.ok) {
        return {
          id: "redis",
          name: "Redis connectivity",
          status: "pass",
          message: redactDoctorText(outcome.detail, env),
          fix: "No action needed.",
        };
      }
      return {
        id: "redis",
        name: "Redis connectivity",
        status: "fail",
        message: redactDoctorText(outcome.detail, env),
        fix: "Verify REDIS_URL and ensure the Redis server is running and reachable.",
      };
    } catch (err) {
      const msg = redactDoctorText(err instanceof Error ? err.message : String(err), env);
      return {
        id: "redis",
        name: "Redis connectivity",
        status: "fail",
        message: `Redis connection failed: ${msg}`,
        fix: "Check REDIS_URL credentials/host and ensure Redis is accepting connections.",
      };
    }
  }

  if (isConfiguredValue(upstashUrl) && isConfiguredValue(upstashToken)) {
    try {
      const endpoint = `${upstashUrl!.replace(/\/+$/, "")}/ping`;
      const res = await fetchFn(endpoint, {
        headers: { Authorization: `Bearer ${upstashToken!}` },
      });
      if (res.ok) {
        return {
          id: "redis",
          name: "Redis connectivity",
          status: "pass",
          message: "Upstash Redis REST endpoint responded to PING",
          fix: "No action needed.",
        };
      }
      return {
        id: "redis",
        name: "Redis connectivity",
        status: "fail",
        message: `Upstash Redis REST returned HTTP ${res.status}`,
        fix: "Verify UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      };
    } catch (err) {
      const msg = redactDoctorText(err instanceof Error ? err.message : String(err), env);
      return {
        id: "redis",
        name: "Redis connectivity",
        status: "fail",
        message: `Upstash Redis REST check failed: ${msg}`,
        fix: "Verify UPSTASH_REDIS_REST_URL reachability and credentials.",
      };
    }
  }

  return {
    id: "redis",
    name: "Redis connectivity",
    status: "warn",
    message: "Neither REDIS_URL nor UPSTASH_REDIS_REST_URL is configured",
    fix: "Set REDIS_URL (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) for queue and rate-limit backing.",
  };
}

export function checkLlmKeys(env: NodeJS.ProcessEnv): DoctorCheckResult {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const detected: string[] = [];

  if (isConfiguredValue(env.GROQ_API_KEY)) detected.push("GROQ_API_KEY");
  if (isConfiguredValue(env.OPENAI_API_KEY)) detected.push("OPENAI_API_KEY");
  if (isConfiguredValue(env.ANTHROPIC_API_KEY)) detected.push("ANTHROPIC_API_KEY");
  if (
    isConfiguredValue(env.GEMINI_API_KEY) ||
    isConfiguredValue(env.GOOGLE_GENERATIVE_AI_API_KEY)
  ) {
    detected.push("GEMINI_API_KEY");
  }

  const hasLocalAi = isConfiguredValue(env.LOCAL_AI_URL) || isConfiguredValue(env.AI_BASE_URL);

  if (provider === "local" || provider === "ollama") {
    if (hasLocalAi) {
      return {
        id: "llm",
        name: "LLM provider key / endpoint",
        status: "pass",
        message: `Local AI provider (${provider}) endpoint is configured`,
        fix: "No action needed.",
      };
    }
    return {
      id: "llm",
      name: "LLM provider key / endpoint",
      status: "warn",
      message: `AI_PROVIDER=${provider} is set without LOCAL_AI_URL or AI_BASE_URL`,
      fix: "Set LOCAL_AI_URL (e.g. http://localhost:11434) or configure a cloud LLM API key.",
    };
  }

  if (detected.length > 0) {
    return {
      id: "llm",
      name: "LLM provider key / endpoint",
      status: "pass",
      message: `LLM key(s) present: ${detected.join(", ")} (values hidden)`,
      fix: "No action needed.",
    };
  }

  if (hasLocalAi) {
    return {
      id: "llm",
      name: "LLM provider key / endpoint",
      status: "pass",
      message: "Local/custom AI base URL configured",
      fix: "No action needed.",
    };
  }

  return {
    id: "llm",
    name: "LLM provider key / endpoint",
    status: "fail",
    message: "No LLM API key (GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY) or LOCAL_AI_URL found",
    fix: "Set GROQ_API_KEY (or another supported LLM API key) in your environment.",
  };
}

function permissionSatisfies(actual: string | undefined, required: "read" | "write"): boolean {
  if (!actual) return false;
  if (required === "read") return actual === "read" || actual === "write" || actual === "admin";
  return actual === "write" || actual === "admin";
}

export async function checkGitHubAppConfig(
  env: NodeJS.ProcessEnv,
  deps: DoctorDependencies,
): Promise<DoctorCheckResult> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_PRIVATE_KEY;

  if (!isConfiguredValue(appId) || !isConfiguredValue(privateKey)) {
    return {
      id: "github-app",
      name: "GitHub App permissions & webhook",
      status: "warn",
      message: "GitHub App credentials (GITHUB_APP_ID / GITHUB_PRIVATE_KEY) not configured; skipping live GitHub check",
      fix: "Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET to enable GitHub PR scanning.",
    };
  }

  let jwt: string;
  try {
    jwt = createGitHubAppJwt(appId!.trim(), privateKey!);
  } catch (err) {
    const msg = redactDoctorText(err instanceof Error ? err.message : String(err), env);
    return {
      id: "github-app",
      name: "GitHub App permissions & webhook",
      status: "fail",
      message: `Failed to sign GitHub App JWT with GITHUB_PRIVATE_KEY: ${msg}`,
      fix: "Ensure GITHUB_PRIVATE_KEY is a valid RSA PEM private key.",
    };
  }

  const apiBase = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const fetchFn = deps.fetchFn ?? fetch;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "secureflow-cli-doctor",
  };

  try {
    const appRes = await fetchFn(`${apiBase}/app`, { headers });
    if (!appRes.ok) {
      return {
        id: "github-app",
        name: "GitHub App permissions & webhook",
        status: "fail",
        message: `GitHub API /app returned HTTP ${appRes.status}`,
        fix: "Verify GITHUB_APP_ID and GITHUB_PRIVATE_KEY match your GitHub App.",
      };
    }

    const appJson = (await appRes.json()) as {
      name?: string;
      permissions?: Record<string, string>;
    };
    const perms = appJson.permissions ?? {};
    const missingPerms: string[] = [];
    for (const [perm, level] of Object.entries(REQUIRED_GITHUB_PERMISSIONS)) {
      if (!permissionSatisfies(perms[perm], level)) {
        missingPerms.push(`${perm}:${level}`);
      }
    }

    if (missingPerms.length > 0) {
      return {
        id: "github-app",
        name: "GitHub App permissions & webhook",
        status: "fail",
        message: `GitHub App missing required permissions: ${missingPerms.join(", ")}`,
        fix: `Grant ${missingPerms.join(", ")} in GitHub App Settings -> Permissions & events.`,
      };
    }

    const hookRes = await fetchFn(`${apiBase}/app/hook/config`, { headers });
    if (!hookRes.ok) {
      return {
        id: "github-app",
        name: "GitHub App permissions & webhook",
        status: "warn",
        message: `GitHub App permissions OK, but webhook config check returned HTTP ${hookRes.status}`,
        fix: "Verify webhook settings in GitHub App Settings -> General -> Webhook.",
      };
    }

    const hookJson = (await hookRes.json()) as { url?: string };
    const hookUrl = hookJson.url?.trim();
    if (!hookUrl) {
      return {
        id: "github-app",
        name: "GitHub App permissions & webhook",
        status: "fail",
        message: "GitHub App webhook URL is not configured",
        fix: "Set the Webhook URL to https://<your-domain>/api/webhooks/github in GitHub App Settings.",
      };
    }

    if (!isConfiguredValue(env.GITHUB_WEBHOOK_SECRET)) {
      return {
        id: "github-app",
        name: "GitHub App permissions & webhook",
        status: "warn",
        message: `GitHub App permissions and webhook URL (${hookUrl}) look valid, but GITHUB_WEBHOOK_SECRET is missing locally`,
        fix: "Set GITHUB_WEBHOOK_SECRET to match the secret configured on your GitHub App.",
      };
    }

    const appUrl = (env.NEXT_PUBLIC_APP_URL || env.AUTH_URL || "").trim();
    if (appUrl) {
      try {
        const expectedHost = new URL(appUrl).host;
        const actualHost = new URL(hookUrl).host;
        if (expectedHost && actualHost && expectedHost !== actualHost) {
          return {
            id: "github-app",
            name: "GitHub App permissions & webhook",
            status: "warn",
            message: `GitHub App webhook host (${actualHost}) differs from NEXT_PUBLIC_APP_URL (${expectedHost})`,
            fix: `Update the GitHub App Webhook URL to match ${appUrl}/api/webhooks/github.`,
          };
        }
      } catch {
        // Ignore invalid URL comparison
      }
    }

    return {
      id: "github-app",
      name: "GitHub App permissions & webhook",
      status: "pass",
      message: `GitHub App permissions and webhook (${redactDoctorText(hookUrl, env)}) verified`,
      fix: "No action needed.",
    };
  } catch (err) {
    const msg = redactDoctorText(err instanceof Error ? err.message : String(err), env);
    return {
      id: "github-app",
      name: "GitHub App permissions & webhook",
      status: "fail",
      message: `GitHub App check failed: ${msg}`,
      fix: "Verify outbound connectivity to GitHub API and check GITHUB_API_URL.",
    };
  }
}

export async function runDoctor(deps: DoctorDependencies = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  const checks: DoctorCheckResult[] = [
    checkEnvironmentVariables(env),
    await checkDatabaseConnectivity(env, deps),
    await checkMigrationStatus(env, cwd, deps),
    await checkRedisConnectivity(env, deps),
    checkLlmKeys(env),
    await checkGitHubAppConfig(env, deps),
  ];

  // Ensure every message & fix is redacted against accidental secret leakage
  const sanitizedChecks = checks.map((c) => ({
    ...c,
    message: redactDoctorText(c.message, env),
    fix: redactDoctorText(c.fix, env),
  }));

  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of sanitizedChecks) {
    if (c.status === "pass") pass++;
    else if (c.status === "warn") warn++;
    else fail++;
  }

  return {
    checks: sanitizedChecks,
    summary: { pass, warn, fail },
    exitCode: fail > 0 ? 1 : 0,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("SecureFlow Doctor — Diagnostics Checklist");
  lines.push("─────────────────────────────────────────");

  for (const check of report.checks) {
    const icon =
      check.status === "pass" ? "✅ [PASS]" : check.status === "warn" ? "⚠️  [WARN]" : "❌ [FAIL]";
    lines.push(`${icon} ${check.name}: ${check.message}`);
    if (check.status !== "pass") {
      lines.push(`   Fix: ${check.fix}`);
    }
  }

  lines.push("─────────────────────────────────────────");
  lines.push(
    `Summary: ${report.summary.pass} passed, ${report.summary.warn} warning(s), ${report.summary.fail} failed`,
  );
  lines.push("");
  return lines.join("\n");
}

export function printDoctorHelp(): void {
  console.log(`
SecureFlow CLI - Environment & Connectivity Doctor

Usage:
  secureflow doctor [options]
  secureflow-cli doctor [options]

Description:
  Diagnoses setup and connectivity issues before running scans:
  - Required and recommended environment variables
  - PostgreSQL database connectivity and Prisma migration status
  - Redis connectivity (REDIS_URL or Upstash REST)
  - LLM API key or local AI endpoint presence
  - GitHub App permissions and webhook configuration (when credentials are set)

Options:
  --json       Output diagnostic report as JSON
  -h, --help   Show this help message
`);
}
