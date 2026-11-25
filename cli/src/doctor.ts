/**
 * SecureFlow Doctor Diagnostic Utility
 *
 * Verifies environment prerequisites, git availability, configuration validity,
 * and AI endpoint / local model reachability before running scans.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { isGitRepository, getRepoRoot } from "./git.js";
import { validateSecureFlowJson } from "./contracts/index.js";

export type CheckStatus = "pass" | "warn" | "fail";

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
  execGit: (cmd: string) => string = (cmd) => execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf-8" }),
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
  } catch (err: any) {
    return {
      name: "Configuration File",
      status: "fail",
      message: `Failed to read ${configFileName}: ${err?.message || String(err)}`,
      fix: `Ensure read permissions on ${configPath}`,
      details: { configPath, exists: true },
    };
  }

  try {
    JSON.parse(rawContent);
  } catch (err: any) {
    return {
      name: "Configuration File",
      status: "fail",
      message: `Invalid JSON syntax in ${configFileName}: ${err?.message || "parse error"}`,
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
  } catch (err: any) {
    return {
      name: "Configuration File",
      status: "fail",
      message: `Schema validation error for ${configFileName}: ${err?.message || String(err)}`,
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
    const output = execSync("nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits", {
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 2000,
    }).trim();

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
 * Guarantees that API keys or secrets are NEVER printed in the report.
 */
export async function checkAiReachability(
  options: DoctorOptions = {},
): Promise<DiagnosticCheckResult> {
  const env = options.env || process.env;
  const argv = options.argv || [];
  const fetchClient = options.fetchFn || globalThis.fetch;
  const vramProbeFn = options.vramProbe || probeVram;

  // Determine provider mode
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

    // Report VRAM
    let vramSummary = "";
    try {
      const vram = vramProbeFn();
      if (vram && vram.freeMb !== undefined) {
        vramSummary = ` [${vram.type || "Memory"}: ${vram.freeMb} MB free / ${vram.totalMb} MB total]`;
      }
    } catch {
      // VRAM probe failure should not break the check
    }

    // Ping endpoint with timeout
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
      } else {
        return {
          name: "AI Reachability",
          status: "warn",
          message: `Local AI provider (${provider}) returned status ${res.status} at ${localUrl}${vramSummary}`,
          fix: `Verify your local model runner ('${provider} serve') is ready and accepting requests`,
          details: { provider, localUrl, status: res.status },
        };
      }
    } catch (err: any) {
      return {
        name: "AI Reachability",
        status: "fail",
        message: `Local AI provider (${provider}) is unreachable at ${localUrl}${vramSummary}`,
        fix: `Start your local model runner (e.g. 'ollama serve' or check container status at ${localUrl})`,
        details: { provider, localUrl, error: err?.message || String(err) },
      };
    }
  }

  // Cloud / Hosted AI provider check
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

  // Check network reachability to cloud endpoint without exposing secret
  const endpointUrl =
    env.AI_BASE_URL ||
    (provider === "groq" ? "https://api.groq.com/openai/v1/models" : "https://api.openai.com/v1/models");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetchClient(endpointUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "SecureFlow-Doctor" },
    });
    clearTimeout(timeout);

    // Any HTTP response (including 401 Unauthorized indicating endpoint is live) confirms reachability
    return {
      name: "AI Reachability",
      status: "pass",
      message: `Cloud AI endpoint (${provider}) is reachable (API key configured: [REDACTED])`,
      details: { provider, hasKey: true, reachable: true },
    };
  } catch (err: any) {
    return {
      name: "AI Reachability",
      status: "fail",
      message: `Cloud AI endpoint (${provider}) is unreachable (network timeout or connection refused)`,
      fix: `Check internet connectivity and outbound HTTPS access to ${provider}`,
      details: { provider, hasKey: true, reachable: false, error: err?.message || String(err) },
    };
  }
}

/**
 * Runs all doctor checks independently and compiles a report.
 */
export async function runDiagnostics(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DiagnosticCheckResult[] = [];

  // Check 1: Node.js version
  checks.push(checkNodeVersion(options.nodeVersion || process.version));

  // Check 2: Git availability
  checks.push(checkGitAvailability(options.gitCommand));

  // Check 3: Configuration file
  checks.push(checkConfigFile(".secureflow.json", options.cwd || process.cwd()));

  // Check 4: AI reachability & VRAM
  try {
    const aiCheck = await checkAiReachability(options);
    checks.push(aiCheck);
  } catch (err: any) {
    checks.push({
      name: "AI Reachability",
      status: "fail",
      message: `AI reachability diagnostic encountered unexpected error: ${err?.message || String(err)}`,
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
 * Formats the diagnostic report into terminal output.
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
    lines.push(`❌ Doctor found ${report.failCount} failing check(s). Please resolve them before scanning.`);
  } else if (report.warnCount > 0) {
    lines.push("✨ All critical checks passed with warnings.");
  } else {
    lines.push("✨ All checks passed! Your environment is ready for SecureFlow scans.");
  }

  return lines.join("\n");
}

/**
 * Main doctor CLI entrypoint.
 */
export async function runDoctor(argv: readonly string[] = process.argv): Promise<number> {
  const report = await runDiagnostics({ argv });
  console.log(formatDoctorReport(report));
  return report.success ? 0 : 1;
}
