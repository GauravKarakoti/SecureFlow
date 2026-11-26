/**
 * Deterministic Obfuscation Detection Rules (#2090)
 *
 * Detects added lines containing:
 * 1. Decode-and-execute patterns: eval(atob(...)), exec(base64.b64decode(...)), Function(...)
 * 2. Very long base64 blobs (>= MIN_BLOB_LENGTH chars of contiguous base64 characters)
 * 3. Very long hex blobs (>= MIN_BLOB_LENGTH chars of contiguous hex characters)
 *
 * Ignores known-safe contexts:
 * - Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, Gemfile.lock, etc.)
 * - Binary/image data URI prefixes (data:image/... kept under DATA_URI_MAX_CHARS)
 * - Test-fixture directories (via DEFAULT_IGNORE_PATHS)
 */

import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch, addedLines } from "@/lib/armor/diff";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const OBFUSCATION_RULE_IDS = {
  DECODE_AND_EXECUTE: "SEC_OBFUSC_DECODE_EXECUTE",
  LONG_BASE64_BLOB: "SEC_OBFUSC_LONG_BASE64_BLOB",
  LONG_HEX_BLOB: "SEC_OBFUSC_LONG_HEX_BLOB",
} as const;

export type ObfuscationRuleId = (typeof OBFUSCATION_RULE_IDS)[keyof typeof OBFUSCATION_RULE_IDS];

/** Minimum contiguous base64 or hex characters to trigger a blob finding. */
export const MIN_BLOB_LENGTH = 200;

/** Maximum data URI length ignored as a potentially legitimate inline image. */
export const DATA_URI_MAX_CHARS = 500;

/** Lockfile names that should never be scanned. */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
  "gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "cargo.lock",
  "pipfile.lock",
  "shrinkwrap.json",
  "npm-shrinkwrap.json",
]);

/** Default directories whose files are excluded from blob scanning (test fixtures, etc.). */
export const DEFAULT_OBFUSC_IGNORE_PATHS: readonly string[] = [
  "__fixtures__",
  "__snapshots__",
  "fixtures",
  "testdata",
  "test-data",
  "mocks",
  "__mocks__",
];

export interface ObfuscationRuleOptions {
  repositoryId?: string;
  enabled?: boolean;
  disabledRules?: string[];
  /** Additional path patterns to ignore (supports glob-like prefix matching). */
  ignorePaths?: string[];
  /** Override minimum blob length threshold. */
  minBlobLength?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isLockfile(filename: string): boolean {
  const base = filename.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return LOCKFILE_NAMES.has(base);
}

function isIgnoredPath(filename: string, extraIgnorePaths?: string[]): boolean {
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/");
  const defaults = [...DEFAULT_OBFUSC_IGNORE_PATHS, ...(extraIgnorePaths ?? [])];
  return defaults.some((seg) => parts.includes(seg.toLowerCase()));
}

function isDataUri(line: string): boolean {
  return /data:[a-z]+\/[a-z0-9+.-]+;base64,/i.test(line) && line.length <= DATA_URI_MAX_CHARS;
}

// Decode-and-execute patterns (language-agnostic)
const DECODE_EXECUTE_PATTERNS: RegExp[] = [
  // JS/TS: eval(atob(...)) or eval(Buffer.from(..., 'base64'))
  /\beval\s*\(\s*atob\s*\(/i,
  /\beval\s*\(\s*Buffer\.from\s*\([^)]*(?:'base64'|"base64")/i,
  // JS/TS: new Function(atob(...))
  /\bnew\s+Function\s*\(\s*atob\s*\(/i,
  /\bnew\s+Function\s*\([^)]{0,80}atob\s*\(/i,
  // Python: exec(base64.b64decode(...)) / eval(base64.b64decode(...))
  /\b(?:exec|eval)\s*\(\s*base64\.b64decode\s*\(/i,
  // Python: exec(codecs.decode(...)) or eval(codecs.decode(...))
  /\b(?:exec|eval)\s*\(\s*codecs\.decode\s*\(/i,
  // Python: compile(base64.b64decode(...), ...)
  /\bcompile\s*\(\s*base64\.b64decode\s*\(/i,
  // Generic: hex decode + exec
  /\b(?:exec|eval)\s*\(\s*bytes\.fromhex\s*\(/i,
  /\b(?:exec|eval)\s*\(\s*unhexlify\s*\(/i,
  // PHP: eval(base64_decode(...))
  /\beval\s*\(\s*base64_decode\s*\(/i,
  // Ruby: eval(Base64.decode64(...))
  /\beval\s*\(\s*Base64\.decode64\s*\(/i,
];

const BASE64_REGEX = /(?:[A-Za-z0-9+/]{4}){50,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
const HEX_REGEX = /(?:0x)?[0-9a-fA-F]{200,}/g;

// ─── Core scanner ────────────────────────────────────────────────────────────

export function checkLineForObfuscation(
  line: string,
  lineNumber: number,
  options: { disabledSet: Set<string>; minBlobLength: number; filename: string },
): ObfuscationFinding[] {
  const { disabledSet, minBlobLength } = options;
  const findings: ObfuscationFinding[] = [];

  // 1. Decode-and-execute
  if (!disabledSet.has(OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE)) {
    for (const pattern of DECODE_EXECUTE_PATTERNS) {
      if (pattern.test(line)) {
        const match = line.match(pattern);
        findings.push({
          ruleId: OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE,
          severity: "HIGH",
          type: "Obfuscation / Decode-and-Execute",
          description: `Decode-and-execute pattern detected: code decodes a base64 or hex string at runtime and immediately executes it. Matched: '${match?.[0]?.slice(0, 80)}'.`,
          oneLineFix:
            "Remove decode-and-execute pattern; store code as plain source or use a safe build step.",
          lineNumber,
          lineSnippet: line,
        });
        break; // one finding per line is enough
      }
    }
  }

  // Skip blob detection for data URIs and short lines
  if (isDataUri(line)) return findings;

  // 2. Long base64 blob
  if (!disabledSet.has(OBFUSCATION_RULE_IDS.LONG_BASE64_BLOB)) {
    BASE64_REGEX.lastIndex = 0;
    const b64matches = [...line.matchAll(BASE64_REGEX)];
    const longestB64 = b64matches.reduce((max, m) => Math.max(max, m[0].length), 0);
    if (longestB64 >= minBlobLength) {
      findings.push({
        ruleId: OBFUSCATION_RULE_IDS.LONG_BASE64_BLOB,
        severity: "MEDIUM",
        type: "Obfuscation / Long Base64 Blob",
        description: `Very long base64-encoded blob detected (${longestB64} chars). Encoded payloads in source code may conceal malicious logic and are hard to review.`,
        oneLineFix:
          "Move the encoded payload to a build artifact, configuration file, or comment it clearly. Never execute decoded content without review.",
        lineNumber,
        lineSnippet: line.slice(0, 300),
      });
    }
  }

  // 3. Long hex blob
  if (!disabledSet.has(OBFUSCATION_RULE_IDS.LONG_HEX_BLOB)) {
    HEX_REGEX.lastIndex = 0;
    const hexMatches = [...line.matchAll(HEX_REGEX)];
    const longestHex = hexMatches.reduce((max, m) => Math.max(max, m[0].length), 0);
    if (longestHex >= minBlobLength) {
      findings.push({
        ruleId: OBFUSCATION_RULE_IDS.LONG_HEX_BLOB,
        severity: "MEDIUM",
        type: "Obfuscation / Long Hex Blob",
        description: `Very long hex-encoded blob detected (${longestHex} chars). Hex payloads in source code may conceal shellcode or configuration overrides.`,
        oneLineFix:
          "Move the hex payload to a binary artifact or explain its purpose with a trusted link. Never decode-and-execute without review.",
        lineNumber,
        lineSnippet: line.slice(0, 300),
      });
    }
  }

  return findings;
}

export interface ObfuscationFinding {
  ruleId: ObfuscationRuleId;
  severity: Severity;
  type: string;
  description: string;
  oneLineFix: string;
  lineNumber: number;
  lineSnippet: string;
}

/**
 * Scans added lines of a single file for obfuscation patterns (#2090).
 */
export function scanFileWithObfuscationRules(
  fileOrFilename: FileChange | string,
  optionsOrPatch?: ObfuscationRuleOptions | string,
  maybeOptions?: ObfuscationRuleOptions,
): ScanFinding[] {
  let file: FileChange;
  let options: ObfuscationRuleOptions;

  if (typeof fileOrFilename === "string") {
    file = {
      filename: fileOrFilename,
      patch: typeof optionsOrPatch === "string" ? optionsOrPatch : "",
    };
    options = maybeOptions || {};
  } else {
    file = fileOrFilename;
    options = (typeof optionsOrPatch === "object" ? optionsOrPatch : maybeOptions) || {};
  }

  if (options.enabled === false) return [];
  if (!file.patch || !file.patch.trim()) return [];
  if (isLockfile(file.filename)) return [];
  if (isIgnoredPath(file.filename, options.ignorePaths)) return [];

  const disabledSet = new Set(options.disabledRules ?? []);
  const minBlobLength = options.minBlobLength ?? MIN_BLOB_LENGTH;
  const repositoryId = options.repositoryId ?? "default-repo";

  if (
    disabledSet.has(OBFUSCATION_RULE_IDS.DECODE_AND_EXECUTE) &&
    disabledSet.has(OBFUSCATION_RULE_IDS.LONG_BASE64_BLOB) &&
    disabledSet.has(OBFUSCATION_RULE_IDS.LONG_HEX_BLOB)
  ) {
    return [];
  }

  // Extract only added lines from the unified diff
  let added: Array<{ number: number; content: string }> = [];
  if (file.patch.includes("@@")) {
    const parsed = parseUnifiedPatch(file.patch);
    added = addedLines(parsed);
  } else {
    const lines = file.patch.split(/\r?\n/);
    let lineNum = 1;
    for (const l of lines) {
      if (
        l.startsWith("+++") ||
        l.startsWith("---") ||
        l.startsWith("diff ") ||
        l.startsWith("index ")
      )
        continue;
      if (l.startsWith("+")) {
        added.push({ number: lineNum, content: l.slice(1) });
        lineNum++;
      } else if (!l.startsWith("-")) {
        lineNum++;
      }
    }
  }

  const findings: ScanFinding[] = [];

  for (const { number, content } of added) {
    const rawFindings = checkLineForObfuscation(content, number, {
      disabledSet,
      minBlobLength,
      filename: file.filename,
    });

    for (const raw of rawFindings) {
      const snippet = raw.lineSnippet.trim().slice(0, 300);
      const fp = computeFingerprint(repositoryId, file.filename, raw.type, snippet);
      const dynFp = computeDynamicFingerprint(repositoryId, file.filename, raw.type, snippet);

      findings.push({
        type: raw.type,
        severity: raw.severity,
        description: `[${raw.ruleId}] ${raw.description}`,
        fileLocation: file.filename,
        lineStart: raw.lineNumber,
        lineEnd: raw.lineNumber,
        codeSnippet: snippet,
        remediation: raw.oneLineFix,
        fingerprint: fp,
        dynamicFingerprint: dynFp.fingerprint,
        matchedSignatures: [raw.ruleId],
        confidence: "HIGH",
        confidenceReason: `Deterministic obfuscation pattern: ${raw.ruleId}`,
      });
    }
  }

  return findings;
}

/**
 * Runs obfuscation detection rules across all changed files (#2090).
 */
export function runObfuscationSecurityRules(
  files: FileChange[],
  options: ObfuscationRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  const findings: ScanFinding[] = [];
  for (const file of files) {
    findings.push(...scanFileWithObfuscationRules(file, options));
  }
  return findings;
}
