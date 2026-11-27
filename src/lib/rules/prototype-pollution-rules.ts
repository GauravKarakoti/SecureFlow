import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import { addedLines, parseUnifiedPatch } from "@/lib/armor/diff";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";

/**
 * Deterministic Prototype Pollution & Unsafe Object Merge Detector (#2208)
 *
 * Detects CWE-1321 prototype pollution sinks in JavaScript / TypeScript:
 * - Direct __proto__, constructor.prototype, or Object.prototype bracket writes
 * - Unguarded dynamic property assignment (target[key] = source[key])
 * - Unsafe Object.assign(target, req.body / req.query / userInput)
 */

export const PROTOTYPE_POLLUTION_RULE_IDS = {
  DIRECT_PROTO_SINK: "SEC_JS_PROTOTYPE_POLLUTION_DIRECT",
  UNGUARDED_DYNAMIC_ASSIGN: "SEC_JS_PROTOTYPE_POLLUTION_DYNAMIC_ASSIGN",
  UNSAFE_OBJECT_ASSIGN: "SEC_JS_PROTOTYPE_POLLUTION_OBJECT_ASSIGN",
} as const;

export type PrototypePollutionRuleId =
  (typeof PROTOTYPE_POLLUTION_RULE_IDS)[keyof typeof PROTOTYPE_POLLUTION_RULE_IDS];

export interface PrototypePollutionFinding {
  ruleId: PrototypePollutionRuleId;
  cwe: "CWE-1321";
  severity: Severity;
  fileLocation: string;
  lineStart: number;
  snippet: string;
  description: string;
  remediation: string;
}

const GUARD_WINDOW_RADIUS = 5;

const GUARD_PATTERNS: RegExp[] = [
  /Object\.hasOwn\s*\(/,
  /\.hasOwnProperty\.call\s*\(/,
  /hasOwnProperty\s*\(/,
  /Object\.create\s*\(\s*null\s*\)/,
  /new\s+Map\s*\(/,
  /["']__proto__["']/,
  /FORBIDDEN_KEYS|DANGEROUS_KEYS|PROTO_KEYS/i,
];

function hasSurroundingGuard(lines: string[], lineIndex: number): boolean {
  const start = Math.max(0, lineIndex - GUARD_WINDOW_RADIUS);
  const end = Math.min(lines.length - 1, lineIndex + 1);
  const windowText = lines.slice(start, end + 1).join("\n");
  // Ignore if the line itself is a guard check (e.g. `if (key === "__proto__")`)
  if (/^\s*if\s*\(/.test(lines[lineIndex])) {
    return true;
  }
  return GUARD_PATTERNS.some((pattern) => pattern.test(windowText));
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function isJsOrTsFile(filename: string): boolean {
  const lang = detectFileLanguage(filename).language.toLowerCase();
  return lang === "javascript" || lang === "typescript";
}

/**
 * Scan full source text for prototype pollution sinks (CWE-1321).
 */
export function scanSourceForPrototypePollution(
  source: string,
  filename: string,
): PrototypePollutionFinding[] {
  if (!isJsOrTsFile(filename)) return [];

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const findings: PrototypePollutionFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isCommentLine(line)) continue;

    // Skip lines that are explicitly checking/blocking __proto__ or constructor
    const isGuardCondition =
      /\bif\s*\(.*(?:__proto__|constructor|prototype)/.test(line) ||
      /\b(?:===|!==|includes|has)\s*\(?["']__proto__["']/.test(line);

    if (
      !isGuardCondition &&
      (/(?:\.__proto__\b|\[["']__proto__["']\])/.test(line) ||
        /\.constructor\.prototype\b|\[["']constructor["']\]\s*\[["']prototype["']\]/.test(line) ||
        /Object\.prototype\s*\[/.test(line))
    ) {
      findings.push({
        ruleId: PROTOTYPE_POLLUTION_RULE_IDS.DIRECT_PROTO_SINK,
        cwe: "CWE-1321",
        severity: "CRITICAL",
        fileLocation: filename,
        lineStart: i + 1,
        snippet: line.trim(),
        description:
          "Direct access or mutation of __proto__, constructor.prototype, or Object.prototype enables prototype pollution.",
        remediation:
          "Reject '__proto__', 'constructor', and 'prototype' keys, or store untrusted data in a Map or Object.create(null).",
      });
      continue;
    }

    // Unguarded dynamic bracket assignment: target[key] = source[key] or target[k] = val
    const dynamicAssignMatch = line.match(
      /\b([a-zA-Z_$][\w$]*)\s*\[\s*([a-zA-Z_$][\w$]*)\s*\]\s*=\s*(.+)/,
    );
    if (dynamicAssignMatch && !hasSurroundingGuard(lines, i)) {
      const rhs = dynamicAssignMatch[3];
      // Focus on object-merge / copy patterns or bracket-indexed source reads
      if (/\[\s*[a-zA-Z_$][\w$]*\s*\]|\b(?:src|source|input|payload|body|req)\b/i.test(rhs)) {
        findings.push({
          ruleId: PROTOTYPE_POLLUTION_RULE_IDS.UNGUARDED_DYNAMIC_ASSIGN,
          cwe: "CWE-1321",
          severity: "HIGH",
          fileLocation: filename,
          lineStart: i + 1,
          snippet: line.trim(),
          description:
            "Unguarded dynamic property assignment can pollute Object.prototype if keys are attacker-controlled.",
          remediation:
            "Guard keys with `if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;` and verify ownership with `Object.hasOwn(src, key)`.",
        });
        continue;
      }
    }

    // Unsafe Object.assign(target, req.body / req.query / untrusted)
    if (
      /Object\.assign\s*\(\s*[a-zA-Z_$][\w$.]*\s*,\s*(?:req\.(?:body|query|params)|userInput|payload|untrusted)/i.test(
        line,
      ) &&
      !hasSurroundingGuard(lines, i)
    ) {
      findings.push({
        ruleId: PROTOTYPE_POLLUTION_RULE_IDS.UNSAFE_OBJECT_ASSIGN,
        cwe: "CWE-1321",
        severity: "HIGH",
        fileLocation: filename,
        lineStart: i + 1,
        snippet: line.trim(),
        description:
          "Object.assign() with unvalidated request or user-controlled input can overwrite prototype properties or sensitive fields.",
        remediation:
          "Validate and pick allowed properties with a schema (e.g. Zod) before merging into target objects.",
      });
    }
  }

  return findings;
}

/**
 * Scan added lines in a unified diff FileChange for prototype pollution sinks.
 */
export function scanChangedFileForPrototypePollution(
  file: FileChange,
  repositoryId = "repo",
): ScanFinding[] {
  if (!file.patch || !isJsOrTsFile(file.filename)) return [];

  const hunks = parseUnifiedPatch(file.patch);
  const added = addedLines(hunks);
  if (added.length === 0) return [];

  const syntheticSource = added.map((item) => item.content).join("\n");
  const rawFindings = scanSourceForPrototypePollution(syntheticSource, file.filename);
  const langFamily = detectFileLanguage(file.filename).language;

  return rawFindings.map((finding) => {
    const actualLine = added[finding.lineStart - 1]?.number ?? finding.lineStart;
    const baseHash = computeFingerprint(
      repositoryId,
      file.filename,
      "Prototype Pollution",
      finding.snippet,
    );
    const dynFp = computeDynamicFingerprint(
      repositoryId,
      file.filename,
      "Prototype Pollution",
      finding.snippet,
    );

    return {
      type: "Prototype Pollution",
      severity: finding.severity,
      description: `[${finding.ruleId}] (${finding.cwe}) ${finding.description}`,
      fileLocation: file.filename,
      lineStart: actualLine,
      lineEnd: actualLine,
      codeSnippet: finding.snippet,
      remediation: finding.remediation,
      dynamicFingerprint: dynFp.fingerprint,
      fingerprint: baseHash,
      matchedSignatures: [finding.ruleId, finding.cwe],
      language: langFamily,
      confidence: "HIGH",
      confidenceReason: `Deterministic prototype pollution rule ${finding.ruleId}`,
    };
  });
}
