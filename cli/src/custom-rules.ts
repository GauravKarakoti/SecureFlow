import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  compileIgnorePatterns,
  shouldIgnorePath,
  normalizeScanPath,
} from "./ignore.js";
import { isValidGlob, stripJsonComments } from "./contracts/index.js";
import { lineOf, type Severity, type Violation, VALID_SEVERITIES } from "./scanner.js";

/** Default timeout in milliseconds for executing a custom regex rule pattern. */
export const DEFAULT_REGEX_TIMEOUT_MS = 100;

/** Maximum length in characters of a line allowed for custom regex evaluation. */
export const MAX_SAFE_LINE_LENGTH = 20_000;

/** Maximum file content size in characters allowed for custom regex evaluation. */
export const MAX_SAFE_FILE_LENGTH = 512 * 1024; // 512 KB

export interface CustomRuleConfig {
  id: string;
  pattern: string;
  globs?: string[] | string | undefined;
  fileGlobs?: string[] | string | undefined;
  paths?: string[] | string | undefined;
  severity: Severity | string;
  message: string;
  flags?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface CompiledCustomRule {
  id: string;
  pattern: string;
  flags: string;
  globs?: string[] | undefined;
  compiledGlobs?: RegExp[] | undefined;
  severity: Severity;
  message: string;
  timeoutMs: number;
}

export interface CustomRuleMatch {
  index: number;
  matchText: string;
}

export interface CustomRuleScanResult {
  violations: Violation[];
  timedOut: boolean;
  aborted?: boolean | undefined;
}

const VM_SCAN_SCRIPT = new vm.Script(
  `(function() {
    const results = [];
    const r = new RegExp(pattern, flags);
    let match;
    let count = 0;
    while ((match = r.exec(text)) !== null && count < 1000) {
      results.push({ index: match.index, matchText: match[0] });
      count++;
      if (!r.global) break;
      if (match.index === r.lastIndex) {
        r.lastIndex++;
      }
    }
    return results;
  })()`
);

/**
 * Validates an individual custom rule configuration.
 * Returns errors or a compiled rule object.
 */
export function validateCustomRule(
  rawRule: unknown,
  ruleIndex = 0,
): { valid: boolean; errors: string[]; rule?: CompiledCustomRule } {
  const errors: string[] = [];

  if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
    return {
      valid: false,
      errors: [`Rule at index ${ruleIndex} must be an object`],
    };
  }

  const r = rawRule as Record<string, unknown>;

  // Validate ID
  const rawId = r.id;
  if (typeof rawId !== "string" || !rawId.trim()) {
    errors.push(`Rule at index ${ruleIndex} is missing required 'id' field`);
  }
  const id = typeof rawId === "string" ? rawId.trim() : `rule-${ruleIndex + 1}`;

  // Validate Pattern
  const rawPattern = r.pattern ?? r.regex;
  if (typeof rawPattern !== "string" || !rawPattern.trim()) {
    errors.push(`Rule '${id}' is missing required 'pattern' field`);
  } else {
    try {
      new RegExp(rawPattern.trim());
    } catch (err: any) {
      errors.push(`Rule '${id}' has invalid regex pattern '${rawPattern}': ${err?.message || String(err)}`);
    }
  }

  // Validate Severity
  const rawSeverity = r.severity;
  let severity: Severity = "HIGH";
  if (typeof rawSeverity !== "string" || !rawSeverity.trim()) {
    errors.push(
      `Rule '${id}' is missing required 'severity' field (expected one of: CRITICAL, HIGH, MEDIUM, LOW)`,
    );
  } else {
    const upper = rawSeverity.trim().toUpperCase() as Severity;
    if (!VALID_SEVERITIES.has(upper)) {
      errors.push(
        `Rule '${id}' has invalid severity '${rawSeverity}'. Expected one of: CRITICAL, HIGH, MEDIUM, LOW`,
      );
    } else {
      severity = upper;
    }
  }

  // Validate Message
  const rawMessage = r.message ?? r.description;
  if (typeof rawMessage !== "string" || !rawMessage.trim()) {
    errors.push(`Rule '${id}' is missing required 'message' field`);
  }
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";

  // Validate Globs (globs / fileGlobs / paths)
  const rawGlobs = r.globs ?? r.fileGlobs ?? r.paths;
  let globs: string[] | undefined;
  let compiledGlobs: RegExp[] | undefined;

  if (rawGlobs !== undefined && rawGlobs !== null) {
    const list: string[] = Array.isArray(rawGlobs)
      ? rawGlobs
      : typeof rawGlobs === "string"
        ? [rawGlobs]
        : [];

    if (!Array.isArray(rawGlobs) && typeof rawGlobs !== "string") {
      errors.push(`Rule '${id}' has invalid 'globs' (must be a string or array of strings)`);
    } else {
      globs = [];
      for (const g of list) {
        if (typeof g !== "string" || !g.trim()) {
          errors.push(`Rule '${id}' contains empty or non-string file glob`);
          continue;
        }
        const trimmedGlob = g.trim();
        if (!isValidGlob(trimmedGlob)) {
          errors.push(`Rule '${id}' has invalid file glob pattern '${trimmedGlob}'`);
          continue;
        }
        globs.push(trimmedGlob);
      }
      if (globs.length > 0) {
        compiledGlobs = compileIgnorePatterns(globs);
      }
    }
  }

  // Flags
  let flags = "gm";
  if (typeof r.flags === "string" && r.flags.trim()) {
    const userFlags = r.flags.trim();
    const flagSet = new Set(["g", "m", ...userFlags.split("")]);
    flags = Array.from(flagSet).join("");
  }

  // Timeout
  const timeoutMs =
    typeof r.timeoutMs === "number" && r.timeoutMs > 0
      ? r.timeoutMs
      : DEFAULT_REGEX_TIMEOUT_MS;

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const compiledRule: CompiledCustomRule = {
    id,
    pattern: (rawPattern as string).trim(),
    flags,
    severity,
    message,
    timeoutMs,
    ...(globs && globs.length > 0 ? { globs, compiledGlobs } : {}),
  };

  return { valid: true, errors: [], rule: compiledRule };
}

/**
 * Validates a list of custom rules, ensuring unique rule IDs and returning compiled rules.
 */
export function validateCustomRules(
  rawRules: unknown,
): { valid: boolean; errors: string[]; compiledRules: CompiledCustomRule[] } {
  if (!Array.isArray(rawRules)) {
    return {
      valid: false,
      errors: ["'rules' must be an array of rule objects in configuration"],
      compiledRules: [],
    };
  }

  const allErrors: string[] = [];
  const compiledRules: CompiledCustomRule[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawRules.length; i++) {
    const res = validateCustomRule(rawRules[i], i);
    if (!res.valid || !res.rule) {
      allErrors.push(...res.errors);
      continue;
    }

    if (seenIds.has(res.rule.id)) {
      allErrors.push(`Duplicate custom rule id '${res.rule.id}'`);
      continue;
    }
    seenIds.add(res.rule.id);
    compiledRules.push(res.rule);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    compiledRules,
  };
}

/**
 * Determines whether a file path matches the rule's glob specifications.
 * If the rule has no globs, matches all files.
 */
export function matchesRuleGlobs(
  filePath: string,
  rule: CompiledCustomRule,
): boolean {
  if (!rule.compiledGlobs || rule.compiledGlobs.length === 0) {
    return true;
  }
  return shouldIgnorePath(filePath, rule.compiledGlobs);
}

/**
 * Bounds content and line lengths to guard against catastrophic memory/string blowups.
 */
export function sanitizeContentForRegex(content: string): string {
  if (content.length > MAX_SAFE_FILE_LENGTH) {
    return content.slice(0, MAX_SAFE_FILE_LENGTH);
  }
  // Check if any line exceeds MAX_SAFE_LINE_LENGTH
  if (content.includes("\n") || content.includes("\r")) {
    const lines = content.split(/\r?\n/);
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.length > MAX_SAFE_LINE_LENGTH) {
        lines[i] = lines[i]!.slice(0, MAX_SAFE_LINE_LENGTH);
        modified = true;
      }
    }
    return modified ? lines.join("\n") : content;
  }
  if (content.length > MAX_SAFE_LINE_LENGTH) {
    return content.slice(0, MAX_SAFE_LINE_LENGTH);
  }
  return content;
}

/**
 * Safely evaluates a compiled custom rule against file content within a time limit (timeoutMs)
 * and length limits to guard against catastrophic regex backtracking (ReDoS).
 */
export function scanContentWithCustomRule(
  filePath: string,
  content: string,
  rule: CompiledCustomRule,
  options?: { quiet?: boolean },
): CustomRuleScanResult {
  if (!matchesRuleGlobs(filePath, rule)) {
    return { violations: [], timedOut: false };
  }

  const safeText = sanitizeContentForRegex(content);
  const timeoutMs = rule.timeoutMs || DEFAULT_REGEX_TIMEOUT_MS;

  try {
    const context = vm.createContext({
      text: safeText,
      pattern: rule.pattern,
      flags: rule.flags,
    });

    const rawMatches = VM_SCAN_SCRIPT.runInContext(context, {
      timeout: timeoutMs,
    }) as CustomRuleMatch[];

    if (!rawMatches || rawMatches.length === 0) {
      return { violations: [], timedOut: false };
    }

    const lines = safeText.split(/\r?\n/);
    const seenLines = new Set<number>();
    const violations: Violation[] = [];

    for (const match of rawMatches) {
      const lineNum = lineOf(safeText, match.index);
      if (seenLines.has(lineNum)) continue;
      seenLines.add(lineNum);

      const lineText = (lines[lineNum - 1] ?? "").trim();
      violations.push({
        line: lineNum,
        text: lineText,
        reason: rule.message,
        severity: rule.severity,
        ruleId: rule.id,
        custom: true,
      });
    }

    return { violations, timedOut: false };
  } catch (err: any) {
    const isTimeout =
      err?.message?.includes("timed out") ||
      err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";

    if (isTimeout) {
      if (!options?.quiet) {
        console.warn(
          `⚠️  [SecureFlow] Custom rule '${rule.id}' timed out after ${timeoutMs}ms on ${filePath} (aborted to prevent catastrophic regex backtracking).`,
        );
      }
      return { violations: [], timedOut: true, aborted: true };
    }

    // Rethrow unexpected execution errors
    throw err;
  }
}

/**
 * Runs all applicable custom rules against a file and collects violations.
 */
export function scanFileWithCustomRules(
  filePath: string,
  content: string,
  rules: CompiledCustomRule[],
  options?: { quiet?: boolean },
): { violations: Violation[]; timedOutRules: string[] } {
  const violations: Violation[] = [];
  const timedOutRules: string[] = [];

  for (const rule of rules) {
    const res = scanContentWithCustomRule(filePath, content, rule, options);
    if (res.timedOut) {
      timedOutRules.push(rule.id);
    }
    if (res.violations.length > 0) {
      violations.push(...res.violations);
    }
  }

  return { violations, timedOutRules };
}

/**
 * Resolves and loads custom rules from configuration (.secureflow.json or custom path).
 */
export function loadCustomRulesFromConfig(options: {
  configPath?: string | undefined;
  targetDir?: string | undefined;
  repoRoot?: string | null | undefined;
} = {}): {
  rules: CompiledCustomRule[];
  errors: string[];
  configPath: string | null;
  loaded: boolean;
} {
  let resolvedConfigPath: string | null = null;

  if (options.configPath) {
    resolvedConfigPath = path.isAbsolute(options.configPath)
      ? options.configPath
      : path.resolve(process.cwd(), options.configPath);
  } else {
    const candidateDirs = [
      options.targetDir,
      options.repoRoot ?? undefined,
      process.cwd(),
    ].filter(Boolean) as string[];

    for (const dir of candidateDirs) {
      const p = path.join(dir, ".secureflow.json");
      if (fs.existsSync(p)) {
        resolvedConfigPath = p;
        break;
      }
    }
  }

  if (!resolvedConfigPath || !fs.existsSync(resolvedConfigPath)) {
    return { rules: [], errors: [], configPath: null, loaded: false };
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedConfigPath, "utf-8");
  } catch (err: any) {
    return {
      rules: [],
      errors: [`Unable to read configuration file '${resolvedConfigPath}': ${err?.message || String(err)}`],
      configPath: resolvedConfigPath,
      loaded: false,
    };
  }

  let json: any;
  try {
    const stripped = stripJsonComments(content).trim();
    if (!stripped.startsWith("{")) {
      if (options.configPath) {
        return {
          rules: [],
          errors: [`Configuration in '${resolvedConfigPath}' must be a JSON object`],
          configPath: resolvedConfigPath,
          loaded: false,
        };
      }
      return { rules: [], errors: [], configPath: null, loaded: false };
    }
    json = JSON.parse(stripped);
  } catch (err: any) {
    if (!options.configPath) {
      return { rules: [], errors: [], configPath: null, loaded: false };
    }
    return {
      rules: [],
      errors: [`Invalid JSON in '${resolvedConfigPath}': ${err?.message || String(err)}`],
      configPath: resolvedConfigPath,
      loaded: false,
    };
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { rules: [], errors: [], configPath: resolvedConfigPath, loaded: true };
  }

  const rawRules = json.rules ?? json.customRules;
  if (rawRules === undefined) {
    return { rules: [], errors: [], configPath: resolvedConfigPath, loaded: true };
  }

  const validation = validateCustomRules(rawRules);
  return {
    rules: validation.compiledRules,
    errors: validation.errors,
    configPath: resolvedConfigPath,
    loaded: true,
  };
}
