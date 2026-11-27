/**
 * SecureFlow Doctor Diagnostic Utility (#2125 & #2100)
 *
 * Verifies local environment prerequisites, git availability, configuration validity,
 * AI endpoint / local model reachability, database/migration/Redis health, and
 * GitHub App permissions/webhook configuration without leaking secrets.
 */

import crypto from "node:crypto";
import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Redis } from "ioredis";
import { isGitRepository, getRepoRoot } from "./git.js";
import { validateSecureFlowJson } from "./contracts/index.js";
import { maskSecrets, REDACTION_PLACEHOLDER } from "./secret-masker.js";

const execFileAsync = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail";
export type DoctorStatus = CheckStatus;

export interface DiagnosticCheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  checks: DiagnosticCheckResult[];
  passedCount: number;
  warnCount: number;
  failCount: number;
  success: boolean;
}

export interface DoctorOptions {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  nodeVersion?: string;
  gitCommand?: (cmd: string) => string;
  vramProbe?: () => { totalMb?: number; freeMb?: number; type?: string } | null;
  fetchFn?: typeof fetch;
}

export interface ServerDoctorCheckResult {
  id: string;
  name: string;
  status: DoctorStatus;
  message: string;
  fix: string;
}

export interface ServerDoctorReport {
  checks: ServerDoctorCheckResult[];
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
  if (
    trimmed.includes("<Password>") ||
    trimmed.includes("-----BEGIN RSA PRIVATE KEY-----\n...\n")
  ) {
    return false;
  }
  return true;
}

export function redactDoctorText(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let out = text;

  out = out.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/g,
    `$1${REDACTION_PLACEHOLDER}$3`,
  );

  for (const key of SENSITIVE_ENV_KEYS) {
    const raw = env[key];
    if (!raw || raw.trim().length < 6) continue;
    const trimmed = raw.trim();
    if (out.includes(trimmed)) {
      out = out.split(trimmed).join(REDACTION_PLACEHOLDER);
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.password && parsed.password.length >= 4 && out.includes(parsed.password)) {
        out = out.split(parsed.password).join(REDACTION_PLACEHOLDER);
      }
    } catch {
      // Not a URL
    }
  }

  return maskSecrets(out);
}

/**
 * 1. Checks Node.js runtime version.
 */
export function checkNodeVersion(
  currentVersion = process.version,
  minMajor = 20,
): DiagnosticCheckResult {
  const clean = currentVersion.startsWith("v") ? currentVersion.slice(1) : currentVersion;
  const major = parseInt(clean.split(".")[0] || "0", 10);

  if (major >= minMajor) {
    return {
      name: "Node.js Version",
      status: "pass",
      message: `Node.js ${currentVersion} meets requirement (>= v${minMajor}.0.0 required)`,
      details: { version: currentVersion, major, minMajor },
    };
  }

  return {
    name: "Node.js Version",
    status: "fail",
    message: `Node.js ${currentVersion} is unsupported (v${minMajor}.0.0 or higher required)`,
    fix: `Upgrade Node.js to v${minMajor}+ using nvm ('nvm install ${minMajor} && nvm use ${minMajor}') or download from https://nodejs.org`,
    details: { version: currentVersion, major, minMajor },
  };
}

/**
 * 2. Checks Git binary availability and repository status.
 */
export function checkGitAvailability(
  execGit: (cmd: string) => string = (cmd) =>
    execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf-8" }),
  checkIsRepo: () => boolean = isGitRepository,
  resolveRepoRoot: () => string | null = getRepoRoot,
): DiagnosticCheckResult {
  let gitVersion = "";
  try {
    gitVersion = execGit("git --version").trim();
  } catch {
    return {
      name: "Git Availability",
      status: "fail",
      message: "git is not installed or not available on PATH",
      fix: "Install git from https://git-scm.com and ensure it is added to your system PATH",
    };
  }

  const isRepo = checkIsRepo();
  if (!isRepo) {
    return {
      name: "Git Availability",
      status: "warn",
      message: `${gitVersion} is installed, but the current directory is not inside a git repository`,
      fix: "Run 'git init' or execute SecureFlow inside a tracked git repository",
      details: { gitVersion, isRepo: false },
    };
  }

  const root = resolveRepoRoot() || process.cwd();
  return {
    name: "Git Availability",
    status: "pass",
    message: `${gitVersion} available (repository root: ${root})`,
    details: { gitVersion, isRepo: true, root },
  };
}

/**
 * 3. Checks configuration file existence and validity.
 */
export function checkConfigFile(
  configFileName = ".secureflow.json",
  cwd = process.cwd(),
): DiagnosticCheckResult {
  const configPath = path.resolve(cwd, configFileName);

  if (!fs.existsSync(configPath)) {
    return {
      name: "Configuration File",
      status: "warn",
      message: `No ${configFileName} found in ${cwd} (default security policies will be used)`,
      fix: "Run 'secureflow init' to interactively generate your .secureflow.json and .secureflowignore configuration",
      details: { configPath, exists: false },
    };
  }

  let rawContent = "";
  try {
    rawContent = fs.readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    return {
      name: "Configuration File",
      status: "fail",
      message: `Failed to read ${configFileName}: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Ensure read permissions on ${configPath}`,
      details: { configPath, exists: true },
    };
  }

  try {
    JSON.parse(rawContent);
  } catch (err: unknown) {
    return {
      name: "Configuration File",
      status: "fail",
      message: `Invalid JSON syntax in ${configFileName}: ${err instanceof Error ? err.message : "parse error"}`,
      fix: `Fix the JSON syntax errors in ${configPath} or re-run 'secureflow init --force'`,
      details: { configPath, syntaxError: true },
    };
  }

  try {
    const errors = validateSecureFlowJson(rawContent, configPath);
    if (errors && errors.length > 0) {
      const errorMsg = errors.map((e) => e.message).join("; ");
      return {
        name: "Configuration File",
        status: "fail",
        message: `Schema validation failed for ${configFileName}: ${errorMsg}`,
        fix: `Review the configuration schema in ${configFileName} or run 'secureflow validate'`,
        details: { configPath, errors },
      };
    }
  } catch (err: unknown) {
    return {
      name: "Configuration File",
      status: "fail",
      message: `Schema validation error for ${configFileName}: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Review the configuration schema in ${configFileName}`,
    };
  }

  return {
    name: "Configuration File",
    status: "pass",
    message: `Configuration file is valid (${configFileName})`,
    details: { configPath, exists: true, valid: true },
  };
}

/**
 * Probes GPU VRAM via nvidia-smi with fallback to system memory.
 */
export function probeVram(): { totalMb?: number; freeMb?: number; type?: string } | null {
  try {
    const output = execSync(
      "nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits",
      {
        stdio: ["pipe", "pipe", "ignore"],
        encoding: "utf-8",
        timeout: 2000,
      },
    ).trim();

    const [totalStr, freeStr] = output.split(",").map((s) => s.trim());
    const totalMb = parseInt(totalStr || "0", 10);
    const freeMb = parseInt(freeStr || "0", 10);

    if (totalMb > 0) {
      return { totalMb, freeMb, type: "NVIDIA GPU" };
    }
  } catch {
    // nvidia-smi not available (e.g. CPU or Apple Silicon)
  }

  const freeSystemMb = Math.round(os.freemem() / (1024 * 1024));
  const totalSystemMb = Math.round(os.totalmem() / (1024 * 1024));
  return {
    totalMb: totalSystemMb,
    freeMb: freeSystemMb,
    type: "Unified System RAM",
  };
}

/**
 * 4. Checks AI endpoint or local model reachability and reports VRAM.
 */
export async function checkAiReachability(
  options: DoctorOptions = {},
): Promise<DiagnosticCheckResult> {
  const env = options.env || process.env;
  const argv = options.argv || [];
  const fetchClient = options.fetchFn || globalThis.fetch;
  const vramProbeFn = options.vramProbe || probeVram;

  const isLocalMode =
    argv.includes("--local") ||
    argv.includes("--ollama") ||
    argv.includes("--vllm") ||
    Boolean(env.LOCAL_AI_URL);

  const provider = isLocalMode
    ? env.LOCAL_AI_PROVIDER || (argv.includes("--vllm") ? "vllm" : "ollama")
    : env.AI_PROVIDER || "groq";

  if (isLocalMode) {
    const defaultUrl = provider === "vllm" ? "http://localhost:8000/v1" : "http://localhost:11434";
    const localUrl = env.LOCAL_AI_URL || defaultUrl;

    let vramSummary = "";
    try {
      const vram = vramProbeFn();
      if (vram && vram.freeMb !== undefined) {
        vramSummary = ` [${vram.type || "Memory"}: ${vram.freeMb} MB free / ${vram.totalMb} MB total]`;
      }
    } catch {
      // VRAM probe failure should not break the check
    }

    try {
      const pingUrl = localUrl.endsWith("/v1") ? `${localUrl}/models` : `${localUrl}/api/tags`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetchClient(pingUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "SecureFlow-Doctor" },
      });
      clearTimeout(timeout);

      if (res.ok || res.status === 404 || res.status === 200) {
        return {
          name: "AI Reachability",
          status: "pass",
          message: `Local AI provider (${provider}) is reachable at ${localUrl}${vramSummary}`,
          details: { provider, localUrl, isLocal: true },
        };
      }
      return {
        name: "AI Reachability",
        status: "warn",
        message: `Local AI provider (${provider}) returned status ${res.status} at ${localUrl}${vramSummary}`,
        fix: `Verify your local model runner ('${provider} serve') is ready and accepting requests`,
        details: { provider, localUrl, status: res.status },
      };
    } catch (err: unknown) {
      return {
        name: "AI Reachability",
        status: "fail",
        message: `Local AI provider (${provider}) is unreachable at ${localUrl}${vramSummary}`,
        fix: `Start your local model runner (e.g. 'ollama serve' or check container status at ${localUrl})`,
        details: {
          provider,
          localUrl,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  const hasKey = Boolean(
    env.GROQ_API_KEY || env.OPENAI_API_KEY || env.SECUREFLOW_API_KEY || env.AI_API_KEY,
  );

  if (!hasKey) {
    return {
      name: "AI Reachability",
      status: "warn",
      message: `No API key detected for cloud AI provider (${provider}). Scans will run in local-only pattern mode.`,
      fix: `Set GROQ_API_KEY or OPENAI_API_KEY in your environment, or pass '--local' to run offline`,
      details: { provider, hasKey: false },
    };
  }

  const endpointUrl =
    env.AI_BASE_URL ||
    (provider === "groq"
      ? "https://api.groq.com/openai/v1/models"
      : "https://api.openai.com/v1/models");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    await fetchClient(endpointUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "SecureFlow-Doctor" },
    });
    clearTimeout(timeout);

    return {
      name: "AI Reachability",
      status: "pass",
      message: `Cloud AI endpoint (${provider}) is reachable (API key configured: [REDACTED])`,
      details: { provider, hasKey: true, reachable: true },
    };
  } catch (err: unknown) {
    return {
      name: "AI Reachability",
      status: "fail",
      message: `Cloud AI endpoint (${provider}) is unreachable (network timeout or connection refused)`,
      fix: `Check internet connectivity and outbound HTTPS access to ${provider}`,
      details: {
        provider,
        hasKey: true,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Runs all CLI environment/git/config/AI checks independently and compiles a report.
 */
export async function runDiagnostics(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DiagnosticCheckResult[] = [];

  checks.push(checkNodeVersion(options.nodeVersion || process.version));
  checks.push(checkGitAvailability(options.gitCommand));
  checks.push(checkConfigFile(".secureflow.json", options.cwd || process.cwd()));

  try {
    const aiCheck = await checkAiReachability(options);
    checks.push(aiCheck);
  } catch (err: unknown) {
    checks.push({
      name: "AI Reachability",
      status: "fail",
      message: `AI reachability diagnostic encountered unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Check your environment variables and network settings",
    });
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  return {
    checks,
    passedCount,
    warnCount,
    failCount,
    success: failCount === 0,
  };
}

/**
 * Formats the CLI diagnostic report into terminal output.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("\n🩺 SecureFlow Doctor Diagnostic Report");
  lines.push("═".repeat(60));

  for (const check of report.checks) {
    if (check.status === "pass") {
      lines.push(`✅ [PASS] ${check.name}: ${check.message}`);
    } else if (check.status === "warn") {
      lines.push(`⚠️  [WARN] ${check.name}: ${check.message}`);
      if (check.fix) {
        lines.push(`   💡 Fix: ${check.fix}`);
      }
    } else {
      lines.push(`❌ [FAIL] ${check.name}: ${check.message}`);
      if (check.fix) {
        lines.push(`   💡 Fix: ${check.fix}`);
      }
    }
  }

  lines.push("═".repeat(60));
  lines.push(
    `Summary: ${report.passedCount} passed, ${report.warnCount} warning(s), ${report.failCount} failed.`,
  );

  if (!report.success) {
    lines.push(
      `❌ Doctor found ${report.failCount} failing check(s). Please resolve them before scanning.`,
    );
  } else if (report.warnCount > 0) {
    lines.push("✨ All critical checks passed with warnings.");
  } else {
    lines.push("✨ All checks passed! Your environment is ready for SecureFlow scans.");
  }

  return lines.join("\n");
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
    const { stdout, stderr } = await execFileAsync(npxCmd, ["prisma", "migrate", "status"], {
      cwd,
      env,
      timeout: 10000,
    });
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

export function createGitHubAppJwt(
  appId: string,
  privateKey: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
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

export function checkEnvironmentVariables(
  env: Readonly<Record<string, string | undefined>>,
): ServerDoctorCheckResult {
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
): Promise<ServerDoctorCheckResult> {
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
): Promise<ServerDoctorCheckResult> {
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
): Promise<ServerDoctorCheckResult> {
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

export function checkLlmKeys(
  env: Readonly<Record<string, string | undefined>>,
): ServerDoctorCheckResult {
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
    message:
      "No LLM API key (GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY) or LOCAL_AI_URL found",
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
): Promise<ServerDoctorCheckResult> {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_PRIVATE_KEY;

  if (!isConfiguredValue(appId) || !isConfiguredValue(privateKey)) {
    return {
      id: "github-app",
      name: "GitHub App permissions & webhook",
      status: "warn",
      message:
        "GitHub App credentials (GITHUB_APP_ID / GITHUB_PRIVATE_KEY) not configured; skipping live GitHub check",
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

export async function runDoctor(deps: DoctorDependencies = {}): Promise<ServerDoctorReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  const checks: ServerDoctorCheckResult[] = [
    checkEnvironmentVariables(env),
    await checkDatabaseConnectivity(env, deps),
    await checkMigrationStatus(env, cwd, deps),
    await checkRedisConnectivity(env, deps),
    checkLlmKeys(env),
    await checkGitHubAppConfig(env, deps),
  ];

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

export function formatServerDoctorReport(report: ServerDoctorReport): string {
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
