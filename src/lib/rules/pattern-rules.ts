/**
 * Deterministic Dangerous Pattern Security Rules (#2088)
 *
 * Scans added lines for dangerous API usage and disabled security controls:
 * - Python: verify=False (TLS disabled), yaml.load without safe loader, pickle.loads
 * - JavaScript / TypeScript: rejectUnauthorized: false, eval(), innerHTML / dangerouslySetInnerHTML
 * - Shell: chmod 777, curl | sh / wget | sh / bash / zsh
 * - Generic: DEBUG = True / debug: true in production settings
 *
 * Emits deterministic findings with rule IDs, severity, one-line fixes,
 * and computed fingerprints for deduplication against LLM findings.
 */

import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch, addedLines } from "@/lib/armor/diff";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";
import { scanChangedFileForPrototypePollution } from "@/lib/rules/prototype-pollution-rules";

export const PATTERN_RULE_IDS = {
  // Python
  PYTHON_TLS_VERIFY_DISABLED: "SEC_PY_TLS_VERIFY_DISABLED",
  PYTHON_UNSAFE_YAML_LOAD: "SEC_PY_UNSAFE_YAML_LOAD",
  PYTHON_UNSAFE_PICKLE: "SEC_PY_UNSAFE_PICKLE",
  PYTHON_DEBUG_ENABLED: "SEC_PY_DEBUG_ENABLED",

  // JavaScript / TypeScript
  JS_TLS_REJECT_UNAUTHORIZED: "SEC_JS_TLS_REJECT_UNAUTHORIZED",
  JS_EVAL_USAGE: "SEC_JS_EVAL_USAGE",
  JS_DANGEROUS_INNER_HTML: "SEC_JS_DANGEROUS_INNER_HTML",

  // Shell
  SHELL_CHMOD_777: "SEC_SHELL_CHMOD_777",
  SHELL_CURL_PIPE_SH: "SEC_SHELL_CURL_PIPE_SH",
} as const;

export type PatternRuleId = (typeof PATTERN_RULE_IDS)[keyof typeof PATTERN_RULE_IDS];

export interface PatternRuleDefinition {
  id: PatternRuleId;
  name: string;
  severity: Severity;
  type: string;
  description: string;
  oneLineFix: string;
  languages: Array<"python" | "javascript" | "typescript" | "shell" | "generic">;
  /** Evaluates an added line. Returns true if line is vulnerable. */
  match: (line: string, filename: string) => boolean;
}

export const PATTERN_RULES: Record<PatternRuleId, PatternRuleDefinition> = {
  [PATTERN_RULE_IDS.PYTHON_TLS_VERIFY_DISABLED]: {
    id: PATTERN_RULE_IDS.PYTHON_TLS_VERIFY_DISABLED,
    name: "Python TLS verification disabled",
    severity: "CRITICAL",
    type: "Insecure Transport",
    description:
      "Disabling TLS certificate validation (verify=False) allows man-in-the-middle (MITM) attacks and credential theft.",
    oneLineFix: "Remove 'verify=False' or set 'verify=True' with a valid CA bundle path.",
    languages: ["python"],
    match: (line: string) => {
      // e.g. requests.get(url, verify=False), ssl._create_unverified_context
      return (
        /\bverify\s*=\s*False\b/i.test(line) ||
        /\b_create_unverified_context\b/.test(line) ||
        /\bcheck_hostname\s*=\s*False\b/i.test(line)
      );
    },
  },

  [PATTERN_RULE_IDS.PYTHON_UNSAFE_YAML_LOAD]: {
    id: PATTERN_RULE_IDS.PYTHON_UNSAFE_YAML_LOAD,
    name: "Python unsafe yaml.load usage",
    severity: "HIGH",
    type: "Insecure Deserialization",
    description:
      "Using yaml.load() without a safe Loader (such as SafeLoader) allows arbitrary code execution via custom YAML tags.",
    oneLineFix: "Use yaml.safe_load(data) or yaml.load(data, Loader=yaml.SafeLoader).",
    languages: ["python"],
    match: (line: string) => {
      // Must have yaml.load(...) but not yaml.safe_load
      if (/\byaml\s*\.\s*safe_load\b/.test(line)) return false;
      if (/\byaml\s*\.\s*load\b/.test(line)) {
        // If it already specifies SafeLoader or CSafeLoader, it is safe
        if (/Loader\s*=\s*(?:yaml\.)?(?:C)?SafeLoader/i.test(line)) return false;
        if (/Loader\s*=\s*(?:yaml\.)?BaseLoader/i.test(line)) return false;
        return true;
      }
      return false;
    },
  },

  [PATTERN_RULE_IDS.PYTHON_UNSAFE_PICKLE]: {
    id: PATTERN_RULE_IDS.PYTHON_UNSAFE_PICKLE,
    name: "Python unsafe pickle deserialization",
    severity: "CRITICAL",
    type: "Insecure Deserialization",
    description:
      "pickle.loads() and pickle.load() construct arbitrary objects via __reduce__, enabling remote code execution on untrusted input.",
    oneLineFix:
      "Replace pickle with a safe serialization format like JSON, Protocol Buffers, or HMAC-signed payloads.",
    languages: ["python"],
    match: (line: string) => {
      return (
        /\bpickle\s*\.\s*(?:loads|load)\b/.test(line) ||
        /\b_pickle\s*\.\s*(?:loads|load)\b/.test(line) ||
        /\bcPickle\s*\.\s*(?:loads|load)\b/.test(line)
      );
    },
  },

  [PATTERN_RULE_IDS.PYTHON_DEBUG_ENABLED]: {
    id: PATTERN_RULE_IDS.PYTHON_DEBUG_ENABLED,
    name: "Debug mode enabled in production settings",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Enabling DEBUG = True exposes sensitive stack traces, environment variables, and interactive debug shells.",
    oneLineFix: "Set DEBUG = False or load DEBUG from an environment variable default to False.",
    languages: ["python"],
    match: (line: string, filename: string) => {
      const lowerFile = filename.toLowerCase();
      // Look for settings, config, prod, or general python settings
      const isSettingsLike =
        lowerFile.includes("setting") ||
        lowerFile.includes("config") ||
        lowerFile.includes("prod") ||
        lowerFile.includes("app") ||
        lowerFile.endsWith(".py");
      if (!isSettingsLike) return false;
      return (
        /^\s*DEBUG\s*=\s*True\b/.test(line) || /\bapp\.run\(.*debug\s*=\s*True.*\)/i.test(line)
      );
    },
  },

  [PATTERN_RULE_IDS.JS_TLS_REJECT_UNAUTHORIZED]: {
    id: PATTERN_RULE_IDS.JS_TLS_REJECT_UNAUTHORIZED,
    name: "Node.js TLS rejectUnauthorized disabled",
    severity: "CRITICAL",
    type: "Insecure Transport",
    description:
      "Setting rejectUnauthorized: false disables TLS certificate verification, allowing eavesdropping and MITM attacks.",
    oneLineFix:
      "Set rejectUnauthorized: true and supply trusted root certificates via the 'ca' option.",
    languages: ["javascript", "typescript"],
    match: (line: string) => {
      return (
        /\brejectUnauthorized\s*:\s*false\b/i.test(line) ||
        /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/i.test(line)
      );
    },
  },

  [PATTERN_RULE_IDS.JS_EVAL_USAGE]: {
    id: PATTERN_RULE_IDS.JS_EVAL_USAGE,
    name: "JavaScript dynamic code evaluation via eval()",
    severity: "HIGH",
    type: "Code Injection",
    description:
      "eval() executes strings as code in the current scope, opening severe code injection and XSS vectors.",
    oneLineFix:
      "Replace eval() with structured JSON.parse(), a lookup table, or dedicated math parsers.",
    languages: ["javascript", "typescript"],
    match: (line: string) => {
      // Match eval(...) or window.eval(...) or global.eval(...)
      // Avoid matching words like evaluation or evaluate or retrieval
      return /(?:^|[^a-zA-Z0-9_$])eval\s*\(/i.test(line) && !/typeof\s+eval\b/.test(line);
    },
  },

  [PATTERN_RULE_IDS.JS_DANGEROUS_INNER_HTML]: {
    id: PATTERN_RULE_IDS.JS_DANGEROUS_INNER_HTML,
    name: "Unsanitized innerHTML or dangerouslySetInnerHTML usage",
    severity: "HIGH",
    type: "Cross-Site Scripting",
    description:
      "Assigning to innerHTML or using dangerouslySetInnerHTML can inject unescaped HTML/scripts leading to Cross-Site Scripting (XSS).",
    oneLineFix:
      "Use textContent, createElement, or sanitize untrusted HTML with DOMPurify before injection.",
    languages: ["javascript", "typescript"],
    match: (line: string) => {
      return (
        /\binnerHTML\s*=\s*/.test(line) ||
        /\bdangerouslySetInnerHTML\s*=\s*/.test(line) ||
        /\bouterHTML\s*=\s*/.test(line)
      );
    },
  },

  [PATTERN_RULE_IDS.SHELL_CHMOD_777]: {
    id: PATTERN_RULE_IDS.SHELL_CHMOD_777,
    name: "Overly permissive chmod 777 permissions",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "chmod 777 grants universal read, write, and execute permissions to all users, enabling privilege escalation and file tampering.",
    oneLineFix:
      "Grant minimal required permissions (e.g. chmod 755 for scripts or chmod 644 / 600 for files).",
    languages: ["shell", "generic"],
    match: (line: string) => {
      return /\bchmod\s+(?:-[a-zA-Z0-9]+\s+)*777\b/.test(line);
    },
  },

  [PATTERN_RULE_IDS.SHELL_CURL_PIPE_SH]: {
    id: PATTERN_RULE_IDS.SHELL_CURL_PIPE_SH,
    name: "Remote script piping to shell execution (curl | sh)",
    severity: "CRITICAL",
    type: "Remote Code Execution",
    description:
      "Piping remote downloads directly into a shell (curl | sh, wget | bash) executes untrusted remote code without integrity checks.",
    oneLineFix:
      "Download the script, inspect it or verify its cryptographic SHA-256 hash before execution.",
    languages: ["shell", "generic"],
    match: (line: string) => {
      return /\b(?:curl|wget)\b[^|;\n]+\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/i.test(line);
    },
  },
};

export interface PatternRuleOptions {
  repositoryId?: string;
  disabledRules?: string[];
  enabled?: boolean;
}

/**
 * Determines file language family for pattern matching.
 */
export function getLanguageFamily(
  filename: string,
): "python" | "javascript" | "typescript" | "shell" | "generic" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) {
    return "python";
  }
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".bash") ||
    lower.endsWith(".zsh") ||
    lower.endsWith(".ksh") ||
    lower.endsWith(".fish")
  ) {
    return "shell";
  }
  return "generic";
}

/**
 * Extracts added lines with their 1-based line numbers from a patch.
 * Ensures matching ONLY runs on added lines (+), never removed or context lines (#2088).
 */
export function extractAddedLines(patch: string): Array<{ number: number; content: string }> {
  if (!patch) return [];

  if (patch.includes("@@")) {
    const parsed = parseUnifiedPatch(patch);
    return addedLines(parsed);
  }

  const lines = patch.split(/\r?\n/);
  const result: Array<{ number: number; content: string }> = [];
  let lineNum = 1;

  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      result.push({
        number: lineNum,
        content: line.slice(1),
      });
      lineNum++;
    } else if (!line.startsWith("-")) {
      lineNum++;
    }
  }

  return result;
}

/**
 * Scans added lines in a single file change for deterministic pattern violations.
 */
export function scanFileWithPatternRules(
  file: FileChange,
  options: PatternRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  if (!file.patch || !file.patch.trim()) return [];

  const disabledSet = new Set(options.disabledRules ?? []);
  const langFamily = getLanguageFamily(file.filename);
  const repositoryId = options.repositoryId || "default-repo";

  // Select rules applicable to this file's language or generic
  const applicableRules = Object.values(PATTERN_RULES).filter((rule) => {
    if (disabledSet.has(rule.id)) return false;
    return (
      rule.languages.includes("generic") ||
      rule.languages.includes(langFamily) ||
      (langFamily === "typescript" && rule.languages.includes("javascript"))
    );
  });

  if (applicableRules.length === 0) return [];

  const added = extractAddedLines(file.patch);
  const findings: ScanFinding[] = [];

  for (const item of added) {
    const rawContent = item.content.trim();
    if (
      !rawContent ||
      rawContent.startsWith("//") ||
      rawContent.startsWith("#") ||
      rawContent.startsWith("/*")
    ) {
      // Skip commented out single lines
      continue;
    }

    for (const rule of applicableRules) {
      if (rule.match(item.content, file.filename)) {
        const lineSnippet = item.content.trim();
        const baseHash = computeFingerprint(repositoryId, file.filename, rule.type, lineSnippet);
        const dynFp = computeDynamicFingerprint(
          repositoryId,
          file.filename,
          rule.type,
          lineSnippet,
        );

        findings.push({
          type: rule.type,
          severity: rule.severity,
          description: `[${rule.id}] ${rule.description}`,
          fileLocation: file.filename,
          lineStart: item.number,
          lineEnd: item.number,
          codeSnippet: item.content,
          remediation: rule.oneLineFix,
          dynamicFingerprint: dynFp.fingerprint,
          fingerprint: baseHash,
          matchedSignatures: [rule.id],
          language: langFamily,
          confidence: "HIGH",
          confidenceReason: `Deterministic pattern match for rule ${rule.id}`,
        });
      }
    }
  }

  return [...findings, ...scanChangedFileForPrototypePollution(file, repositoryId)];
}

/**
 * Runs deterministic pattern security rules across all modified files (#2088).
 */
export function runPatternSecurityRules(
  files: FileChange[],
  options: PatternRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  const findings: ScanFinding[] = [];

  for (const file of files) {
    const fileFindings = scanFileWithPatternRules(file, options);
    findings.push(...fileFindings);
  }

  return findings;
}
