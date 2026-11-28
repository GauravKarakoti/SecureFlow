/**
 * The secret-logging detector, separated from the CLI shell.
 *
 * Everything here is pure: it takes text and returns violations. The process
 * exit, the git calls and the console output live in `./index` and `./git`, so
 * the part that decides whether a commit is blocked can actually be tested
 * (#593).
 */

import { formatSarifJson } from "./sarif.js";
import { getExporter } from "./exporters.js";
import {
  calculateShannonEntropy,
  isBenignSecretCandidate,
  hasHighEntropy,
  BENIGN_SECRET_WHITELIST_EXACT,
  UUID_REGEX,
} from "./entropy.js";
import { CliUsageError } from "./lib/output-args.js";
import {
  shouldIgnorePath,
  parseSecureFlowIgnore,
  compileIgnorePatterns,
  loadSecureFlowIgnore,
  normalizeScanPath,
  DEFAULT_IGNORE_PATTERNS,
  getEffectiveIgnorePatterns,
  type SecureFlowIgnoreConfig,
} from "./ignore.js";
import {
  parseIsoDateUtc,
  parseInlineDirective,
  parseAllDirectives,
  isViolationSuppressed,
  applyInlineSuppressions,
  type InlineDirective,
  type InlineSuppressionOptions,
  type SuppressionMatchResult,
} from "./suppression.js";
import {
  scanFileWithCustomRules,
  scanContentWithCustomRule,
  validateCustomRules,
  loadCustomRulesFromConfig,
  type CompiledCustomRule,
  type CustomRuleConfig,
} from "./custom-rules.js";
import { shouldRunAstAnalysis, scanFileWithAst } from "./ast-analyzer.js";
import {
  DEFAULT_BASELINE_FILENAME,
  computeBaselineFingerprint,
  computeSnippetHash,
  createBaselineFromResults,
  loadBaseline,
  saveBaseline,
  matchViolationAgainstBaseline,
  filterResultsWithBaseline,
  updateBaselineWithResults,
  type BaselineFile,
  type BaselineViolation,
  type FilterBaselineResult,
  type UpdateBaselineResult,
} from "./baseline.js";

export {
  scanFileWithCustomRules,
  scanContentWithCustomRule,
  validateCustomRules,
  loadCustomRulesFromConfig,
  type CompiledCustomRule,
  type CustomRuleConfig,
  shouldRunAstAnalysis,
  scanFileWithAst,
  calculateShannonEntropy,
  isBenignSecretCandidate,
  hasHighEntropy,
  BENIGN_SECRET_WHITELIST_EXACT,
  UUID_REGEX,
  shouldIgnorePath,
  parseSecureFlowIgnore,
  compileIgnorePatterns,
  loadSecureFlowIgnore,
  normalizeScanPath,
  DEFAULT_IGNORE_PATTERNS,
  getEffectiveIgnorePatterns,
  type SecureFlowIgnoreConfig,
  parseIsoDateUtc,
  parseInlineDirective,
  parseAllDirectives,
  isViolationSuppressed,
  applyInlineSuppressions,
  type InlineDirective,
  type InlineSuppressionOptions,
  type SuppressionMatchResult,
  DEFAULT_BASELINE_FILENAME,
  computeBaselineFingerprint,
  computeSnippetHash,
  createBaselineFromResults,
  loadBaseline,
  saveBaseline,
  matchViolationAgainstBaseline,
  filterResultsWithBaseline,
  updateBaselineWithResults,
  type BaselineFile,
  type BaselineViolation,
  type FilterBaselineResult,
  type UpdateBaselineResult,
};

export {
  computeContentHash,
  DEFAULT_RULESET_VERSION,
  getRulesetVersion,
  setRulesetVersion,
  resetRulesetVersion,
  resolveCacheDir,
  getCacheEntry,
  setCacheEntry,
  clearCache,
  scanFileWithCache,
  scanFilesWithCache,
  type CacheEntry,
  type ClearCacheResult,
  type ScanFileWithCacheOptions,
  type ScanFileWithCacheResult,
  type BatchScanResult,
} from "./cache.js";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
]);

/** One flagged call site or rule violation. */
export interface Violation {
  /** 1-based line of the `console.*` call or custom rule match. */
  line: number;
  /** The source line as written, for the report. */
  text: string;
  /** Which indicator or rule matched, so the message can say why. */
  reason: string;
  severity?: Severity | undefined;
  ruleId?: string;
  custom?: boolean;
  helpUrl?: string | undefined;
  guidance?: string | undefined;
  /** Set if finding was suppressed via inline comment directive (#2051) */
  suppression?:
    | {
        reason: string;
        expires?: string | undefined;
        line?: number | undefined;
      }
    | undefined;
  /** Baseline state if scanned with baseline filtering (#2060) */
  baselineState?: "new" | "existing" | "absent" | "updated" | undefined;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "table", "dir"];
const CONSOLE_CALL = new RegExp(`console\\s*\\.\\s*(?:${CONSOLE_METHODS.join("|")})\\s*\\(`, "g");
const SECRET_WORDS =
  /password|passwd|passphrase|secret|token|credential|apikey|privatekey|signingkey|encryptionkey/;
const TOKEN_COUNT_FORMS =
  /tokeni[sz](?:er|ers|ed|es|ing|ation)?|(?:max|min|total|prompt|completion|input|output|num|remaining|used|reasoning|cached)tokens?|tokens?(?:count|counts|usage|limit|limits|length|budget|estimate|cost)/g;

export function isSecretIdentifier(name: string): boolean {
  if (isBenignSecretCandidate(name)) {
    return false;
  }
  const normalized = name.replace(/[_-]/g, "").toLowerCase();
  return SECRET_WORDS.test(normalized.replace(TOKEN_COUNT_FORMS, ""));
}

interface IndicatorMatcher {
  test(text: string): boolean;
}

const SECRET_IDENTIFIER: IndicatorMatcher = {
  test: (text) => (text.match(/[A-Za-z_$][\w$]*/g) ?? []).some(isSecretIdentifier),
};

const COMPOUND_SECRET_PATTERN =
  /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|authorization)\b/i;

const COMPOUND_SECRET_IDENTIFIER: IndicatorMatcher = {
  test: (text) => {
    const tokens = text.match(/[A-Za-z_$][\w$]*/g) ?? [];
    return tokens.some(
      (token) => !isBenignSecretCandidate(token) && COMPOUND_SECRET_PATTERN.test(token),
    );
  },
};

const INDICATORS: ReadonlyArray<readonly [string, IndicatorMatcher]> = [
  [
    "environment variable",
    /\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|Deno\s*\.\s*env|os\s*\.\s*environ)\b/,
  ],
  ["secret-named identifier", SECRET_IDENTIFIER],
  ["secret-named identifier", COMPOUND_SECRET_IDENTIFIER],
];

const BINARY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".avif",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".mov",
  ".avi",
  ".webm",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".wasm",
  ".class",
  ".jar",
  ".sqlite",
  ".db",
];

const GENERATED_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
];

export const MAX_SCANNED_BYTES = 512 * 1024;

export function shouldScanFile(
  path: string,
  byteLength?: number,
  customIgnores?: RegExp[],
): boolean {
  if (customIgnores && shouldIgnorePath(path, customIgnores)) return false;

  const lower = path.toLowerCase();
  const basename = lower.split("/").pop() ?? lower;

  if (!customIgnores && GENERATED_FILES.some((name) => basename === name.toLowerCase())) {
    return false;
  }
  if (BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  if (typeof byteLength === "number" && byteLength > MAX_SCANNED_BYTES) return false;

  return true;
}

export function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}

const MASK_CHAR = "·";

export function maskStringLiterals(source: string): string {
  const out = source.split("");
  let index = 0;

  while (index < out.length) {
    const char = out[index];

    if (char === "/" && out[index + 1] === "/") {
      while (index < out.length && out[index] !== "\n") {
        out[index] = MASK_CHAR;
        index += 1;
      }
      continue;
    }

    if (char === "/" && out[index + 1] === "*") {
      index += 2;
      while (index < out.length && !(out[index] === "*" && out[index + 1] === "/")) {
        if (out[index] !== "\n") out[index] = MASK_CHAR;
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char !== '"' && char !== "'" && char !== "`") {
      index += 1;
      continue;
    }

    const quote = char;
    index += 1;

    while (index < out.length) {
      const current = out[index];

      if (current === "\\") {
        if (out[index] !== "\n") out[index] = MASK_CHAR;
        if (index + 1 < out.length && out[index + 1] !== "\n") out[index + 1] = MASK_CHAR;
        index += 2;
        continue;
      }

      if (current === quote) {
        index += 1;
        break;
      }

      if (current === "\n" && quote !== "`") break;

      if (quote === "`" && current === "$" && out[index + 1] === "{") {
        let depth = 1;
        index += 2;
        while (index < out.length && depth > 0) {
          if (out[index] === "{") depth += 1;
          else if (out[index] === "}") depth -= 1;
          index += 1;
        }
        continue;
      }

      if (current !== "\n") out[index] = MASK_CHAR;
      index += 1;
    }
  }

  return out.join("");
}

export function readArgumentList(source: string, openParen: number): string | null {
  let depth = 0;

  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }

  return null;
}

export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

export function findSecretLogging(source: string): Violation[] {
  if (!source) return [];

  const masked = maskStringLiterals(source);
  const lines = source.split(/\r?\n/);
  const violations: Violation[] = [];

  CONSOLE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CONSOLE_CALL.exec(masked)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const args = readArgumentList(masked, openParen);
    if (args === null) continue;

    const indicator = INDICATORS.find(([, pattern]) => pattern.test(args));
    if (!indicator) continue;

    const line = lineOf(masked, match.index);
    violations.push({
      line,
      text: (lines[line - 1] ?? "").trim(),
      reason: indicator[0],
      severity: "HIGH",
    });
  }

  return violations;
}

export interface FileScanResult {
  path: string;
  violations: Violation[];
  suppressedViolations?: Violation[] | undefined;
  skipped?: string | undefined;
}

export interface ScanFileOptions extends InlineSuppressionOptions {
  customRules?: CompiledCustomRule[] | undefined;
}

/** Scan one staged blob, optionally evaluating custom rules and inline suppressions. */
export function scanFile(
  path: string,
  content: string,
  customIgnores?: RegExp[],
  optionsOrCustomRules?: ScanFileOptions | CompiledCustomRule[],
): FileScanResult {
  const options: ScanFileOptions = Array.isArray(optionsOrCustomRules)
    ? { customRules: optionsOrCustomRules }
    : (optionsOrCustomRules ?? {});

  const effectiveIgnores = customIgnores ?? compileIgnorePatterns([...DEFAULT_IGNORE_PATTERNS]);
  if (effectiveIgnores && shouldIgnorePath(path, effectiveIgnores)) {
    return { path, violations: [], skipped: "matched .secureflowignore" };
  }

  if (!shouldScanFile(path, Buffer.byteLength(content, "utf-8"), effectiveIgnores)) {
    return { path, violations: [], skipped: "excluded by type or size" };
  }

  if (looksBinary(content)) {
    return { path, violations: [], skipped: "binary content" };
  }

  const rawViolations = findSecretLogging(content);
  if (options.customRules && options.customRules.length > 0) {
    const { violations: customViolations } = scanFileWithCustomRules(
      path,
      content,
      options.customRules,
    );
    rawViolations.push(...customViolations);
  }

  // AST Semantic Taint Analysis (#2062)
  if (shouldRunAstAnalysis(path)) {
    const astViolations = scanFileWithAst(path, content);
    for (const av of astViolations) {
      // One line can break several QNX rules, so those only de-duplicate per rule
      const perRule = av.ruleId?.startsWith("QNX-") ?? false;
      const alreadyFlagged = rawViolations.some(
        (rv) =>
          rv.line === av.line &&
          rv.text.trim() === av.text.trim() &&
          (!perRule || rv.ruleId === av.ruleId),
      );
      if (!alreadyFlagged) {
        rawViolations.push(av);
      }
    }
  }

  const { activeViolations, suppressedViolations } = applyInlineSuppressions(
    rawViolations,
    content,
    options,
  );

  return {
    path,
    violations: activeViolations,
    ...(suppressedViolations.length > 0 ? { suppressedViolations } : {}),
  };
}

export type OutputFormat = "text" | "json" | "sarif" | "csv" | "html" | "markdown" | "md" | "junit";

export function formatScanResults(
  results: FileScanResult[],
  format: OutputFormat = "text",
  options?: {
    toolVersion?: string;
    repoUri?: string;
    remediations?: Record<string, string>;
    aiFindings?: any[];
    failOnThreshold?: FailOnSeverity | null;
  },
): string {
  if (format === "json") {
    return JSON.stringify(results, null, 2);
  }

  if (format === "sarif") {
    return formatSarifJson(results, options);
  }

  if (format === "text") {
    let text = "";
    for (const r of results) {
      for (const v of r.violations) {
        if (v.custom || (v.ruleId && v.ruleId !== "console-secret-logging")) {
          text += `🚨 [SecureFlow] [Custom Rule: ${v.ruleId || "custom"}] Violation detected in ${r.path}:${v.line}\n`;
          text += `   -> ${v.text}\n`;
          text += `   why: ${v.reason}\n`;
        } else {
          text += `🚨 [SecureFlow] Secret logging detected in ${r.path}:${v.line}\n`;
          text += `   -> ${v.text}\n`;
          text += `   why: ${v.reason} passed to a console call\n`;
        }
      }
    }
    return text;
  }

  try {
    const exporter = getExporter(format);
    return exporter.export(results, options);
  } catch {
    throw new Error(`Unsupported output format: ${format}`);
  }
}

export type FailOnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

const SEVERITY_RANK: Record<FailOnSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};

export function isValidFailOnSeverity(val: string): boolean {
  return ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"].includes(val.toUpperCase());
}

const FAIL_ON_EXPECTED = "expected one of: CRITICAL, HIGH, MEDIUM, LOW, NONE";

export function parseFailOnArg(args: string[] = process.argv): FailOnSeverity | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith("--fail-on=")) {
      const raw = arg.slice("--fail-on=".length);
      const val = raw.toUpperCase();
      if (val && isValidFailOnSeverity(val)) return val as FailOnSeverity;
      throw new CliUsageError(`Unknown --fail-on value "${raw}" (${FAIL_ON_EXPECTED})`);
    }
    if (arg === "--fail-on") {
      const nextArg = args[i + 1];
      const val = nextArg?.toUpperCase();
      if (val && isValidFailOnSeverity(val)) return val as FailOnSeverity;
      throw new CliUsageError(
        nextArg === undefined
          ? `--fail-on requires a value (${FAIL_ON_EXPECTED})`
          : `Unknown --fail-on value "${nextArg}" (${FAIL_ON_EXPECTED})`,
      );
    }
  }
  return null;
}

export function blockingAiFindings<T extends { severity: string }>(
  aiFindings: T[],
  failOnThreshold: FailOnSeverity | null = null,
): T[] {
  if (failOnThreshold === "NONE") return [];

  if (failOnThreshold === null) {
    return aiFindings.filter((f) => {
      const sev = f.severity?.toUpperCase();
      return sev === "HIGH" || sev === "CRITICAL";
    });
  }

  const thresholdRank = SEVERITY_RANK[failOnThreshold];
  return aiFindings.filter((f) => {
    const findingSev = (f.severity?.toUpperCase() as FailOnSeverity) || "LOW";
    return (SEVERITY_RANK[findingSev] ?? 1) >= thresholdRank;
  });
}

export function describeFailThreshold(failOnThreshold: FailOnSeverity | null): string {
  return failOnThreshold === null
    ? "the default HIGH/CRITICAL threshold"
    : `the --fail-on=${failOnThreshold} threshold`;
}

export function shouldFailScan(
  localViolationCount: number | Array<{ severity?: string }>,
  aiFindings: { severity: string }[],
  failOnThreshold: FailOnSeverity | null = null,
  allLocalViolations?: Array<{ severity?: string }>,
): boolean {
  if (failOnThreshold === "NONE") return false;

  const localList: Array<{ severity?: string }> =
    allLocalViolations ??
    (Array.isArray(localViolationCount)
      ? localViolationCount
      : Array(localViolationCount).fill({ severity: "HIGH" }));

  if (failOnThreshold === null) {
    const localHighOrCritical = localList.filter((v) => {
      const sev = (v.severity || "HIGH").toUpperCase();
      return sev === "HIGH" || sev === "CRITICAL";
    }).length;
    const aiHighOrCritical = aiFindings.filter((f) => {
      const sev = f.severity?.toUpperCase();
      return sev === "HIGH" || sev === "CRITICAL";
    }).length;
    return localHighOrCritical > 0 || aiHighOrCritical > 0;
  }

  const thresholdRank = SEVERITY_RANK[failOnThreshold];

  for (const violation of localList) {
    const sev = ((violation.severity || "HIGH").toUpperCase() as FailOnSeverity) || "HIGH";
    const rank = SEVERITY_RANK[sev] ?? 1;
    if (rank >= thresholdRank) {
      return true;
    }
  }

  for (const finding of aiFindings) {
    const findingSev = (finding.severity?.toUpperCase() as FailOnSeverity) || "LOW";
    const rank = SEVERITY_RANK[findingSev] ?? 1;
    if (rank >= thresholdRank) {
      return true;
    }
  }

  return false;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export function countFindingsBySeverity(
  localViolationCount: number | Array<{ severity?: string }>,
  aiFindings: { severity?: string }[] = [],
  allLocalViolations?: Array<{ severity?: string }>,
): SeverityCounts {
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  const localList: Array<{ severity?: string }> =
    allLocalViolations ??
    (Array.isArray(localViolationCount)
      ? localViolationCount
      : Array(localViolationCount).fill({ severity: "HIGH" }));

  for (const v of localList) {
    const sev = (v.severity || "HIGH").toUpperCase();
    if (sev === "CRITICAL") {
      critical++;
    } else if (sev === "HIGH") {
      high++;
    } else if (sev === "MEDIUM") {
      medium++;
    } else if (sev === "LOW") {
      low++;
    }
  }

  for (const f of aiFindings) {
    const sev = (f.severity || "LOW").toUpperCase();
    if (sev === "CRITICAL") {
      critical++;
    } else if (sev === "HIGH") {
      high++;
    } else if (sev === "MEDIUM") {
      medium++;
    } else if (sev === "LOW") {
      low++;
    }
  }

  return { critical, high, medium, low };
}

export function formatSeverityCounts(counts: SeverityCounts): string {
  return `Findings by severity: critical: ${counts.critical}, high: ${counts.high}, medium: ${counts.medium}, low: ${counts.low}`;
}

export function parseSeverityFilter(value: string): Set<Severity> {
  const levels = value.split(",").map((s) => s.trim().toUpperCase());
  const invalid = levels.filter((l) => !VALID_SEVERITIES.has(l as Severity));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid severity level(s): ${invalid.join(", ")}. Valid levels: CRITICAL, HIGH, MEDIUM, LOW`,
    );
  }
  return new Set(levels as Severity[]);
}

export function filterBySeverity(
  results: FileScanResult[],
  severities: ReadonlySet<Severity>,
): FileScanResult[] {
  return results.map((file) => ({
    ...file,
    violations: file.violations.filter((v) => !v.severity || severities.has(v.severity)),
  }));
}

export function generateVoiceSummaryText(
  violationCount: number,
  aiFindings: { severity?: string; type?: string }[] = [],
  passed: boolean = true,
): string {
  if (passed && violationCount === 0 && aiFindings.length === 0) {
    return "SecureFlow scan passed cleanly. Zero secret exposures or security findings detected in staged files.";
  }

  const parts: string[] = [];
  if (violationCount > 0) {
    parts.push(`${violationCount} secret-logging violation${violationCount === 1 ? "" : "s"}`);
  }
  if (aiFindings.length > 0) {
    parts.push(`${aiFindings.length} AI-detected finding${aiFindings.length === 1 ? "" : "s"}`);
  }

  const details = parts.join(" and ");
  if (!passed) {
    return `Security alert. SecureFlow blocked this commit. Found ${details}. Please review terminal output and remove exposed secrets.`;
  }

  return `SecureFlow advisory warning. Found ${details}. Scan passed below blocking threshold.`;
}
