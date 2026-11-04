/**
 * Pure, dependency-free deterministic secret pre-scanner.
 *
 * Runs before LLM scanning to immediately detect leaked credentials
 * and provide resilient secret detection even when the LLM is down or times out (#1448).
 */

import { computeDynamicFingerprint } from "./fingerprint";
import { parseUnifiedPatch, addedLines } from "./diff";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "./scanner";

export interface SecretFamily {
  id: string;
  name: string;
  severity: Severity;
  pattern: RegExp;
  extractValue?: (match: RegExpExecArray) => string;
}

/**
 * Common non-secret placeholder patterns to exclude from flagging.
 */
export const PLACEHOLDER_PATTERN =
  /(?:YOUR_API_KEY_HERE|YOUR_SECRET_KEY|changeme|change[_-]me|replace[_-]me|placeholder|dummy[_-]key|example[_-]key|sample[_-]key|mock[_-]|fake[_-]|\b(?:true|false|null|undefined|none|0|1|""|'')\b)/i;

/**
 * Values clearly labelled as documentation samples, e.g. AWS's documented
 * `AKIAIOSFODNN7EXAMPLE` key, or `changeme` style values (#1517).
 */
const LABELLED_SAMPLE_PATTERN = /example|changeme/i;

/**
 * Quoted assignments need at least this much Shannon entropy (bits per
 * character) to count as a secret, so values like "aaaaaaaaaaaaaaaa" are not
 * flagged (#1517).
 */
export const ASSIGNMENT_MIN_ENTROPY = 3;

/**
 * Checks whether a value is an obvious placeholder, test fixture, or variable lookup.
 */
export function isPlaceholder(val: string, customPlaceholders: string[] = []): boolean {
  const trimmed = val.trim();
  if (!trimmed) return true;

  for (const cp of customPlaceholders) {
    if (cp && trimmed.toLowerCase().includes(cp.toLowerCase())) {
      return true;
    }
  }

  if (
    /^(?:process\.env\b|import\.meta(?:\.env)?\b|os\.(?:environ|getenv)\b|\$\{|<|your[_-]|actual[_-]|placeholder|change[_-]me|replace[_-]me|mock[_-]|fake[_-]|dummy[_-]|sample[_-]|example[_-]|test[_-]|temp[_-]|insert[_-]|YOUR_API_KEY_HERE|YOUR_SECRET_KEY|changeme)$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // #1517: values labelled EXAMPLE / changeme are documentation, not credentials.
  if (LABELLED_SAMPLE_PATTERN.test(trimmed)) {
    return true;
  }

  return PLACEHOLDER_PATTERN.test(trimmed);
}

/**
 * Masks the middle of a secret value, retaining leading and trailing characters
 * for identification while ensuring credentials are never exposed in logs,
 * findings, or pull request comments.
 */
export function maskSecretValue(secret: string): string {
  if (secret.startsWith("-----BEGIN")) {
    return "-----BEGIN PRIVATE KEY [MASKED]-----";
  }
  if (secret.startsWith("github_pat_")) {
    return `github_pat_${secret.slice(11, 14)}...${secret.slice(-4)}`;
  }
  if (secret.length <= 8) {
    return secret.slice(0, 2) + "..." + secret.slice(-2);
  }
  const prefixLen = Math.min(6, Math.max(4, Math.floor(secret.length / 4)));
  const suffixLen = Math.min(4, Math.max(2, Math.floor(secret.length / 4)));
  return `${secret.slice(0, prefixLen)}...${secret.slice(-suffixLen)}`;
}

/**
 * Masks all occurrences of secrets in a code snippet line.
 */
export function maskSnippet(line: string, secrets: string[]): string {
  let result = line;
  for (const secret of secrets) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join(maskSecretValue(secret));
    }
  }
  return result;
}

/**
 * Five primary rule-based secret families.
 *
 * Every deterministic secret finding is CRITICAL (#1517).
 */
export const SECRET_FAMILIES: readonly SecretFamily[] = [
  // 1. AWS access key IDs
  {
    id: "aws-access-key-id",
    name: "AWS Access Key ID",
    severity: "CRITICAL",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  // 2. GitHub tokens (classic ghp, fine-grained github_pat, OAuth/user/server gho/ghu/ghs/ghr)
  {
    id: "github-token",
    name: "GitHub Token",
    severity: "CRITICAL",
    pattern: /\b(?:gh[oprsu]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g,
  },
  // 3. Slack tokens (bot, user, app, refresh)
  {
    id: "slack-token",
    name: "Slack Token",
    severity: "CRITICAL",
    pattern: /\bxox[baprse]-[a-zA-Z0-9-]{10,}\b/g,
  },
  // 4. PEM private-key headers
  {
    id: "pem-private-key",
    name: "PEM Private Key Header",
    severity: "CRITICAL",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // 5. Generic quoted secret assignment (name containing secret, token, password, or api_key)
  {
    id: "quoted-secret-assignment",
    name: "Quoted Secret Assignment",
    severity: "CRITICAL",
    pattern:
      /(?:(?<=[^\w])|^)(?:[a-zA-Z0-9_.-]*(?:secret|token|password|passwd|pwd|api_key|apikey)[a-zA-Z0-9_.-]*)\s*[:=]\s*(["'`])([^"'\`\n]{16,})\1/gi,
    extractValue: (match: RegExpExecArray) => match[2],
  },
];

/**
 * Shannon entropy of value, in bits per character.
 */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const frequencies = new Map<string, number>();
  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Scans added lines in a single file's diff and returns deterministic findings.
 */
export function detectSecretsInAddedLines(
  filename: string,
  added: Array<{ number: number; content: string }>,
  customPlaceholders: string[] = [],
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (const line of added) {
    const content = line.content;
    const detectedSecretsInLine: string[] = [];
    let lineFinding: ScanFinding | null = null;

    for (const family of SECRET_FAMILIES) {
      family.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = family.pattern.exec(content)) !== null) {
        const rawSecret = family.extractValue ? family.extractValue(match) : match[0];

        if (isPlaceholder(rawSecret, customPlaceholders)) {
          continue;
        }

        // #1517: a secret-named variable only counts when the value is
        // high-entropy. Provider-prefixed formats (AWS, GitHub, ...) are exempt.
        if (
          family.id === "quoted-secret-assignment" &&
          shannonEntropy(rawSecret) < ASSIGNMENT_MIN_ENTROPY
        ) {
          continue;
        }

        detectedSecretsInLine.push(rawSecret);

        if (!lineFinding) {
          const dynFp = computeDynamicFingerprint(
            "default-repo",
            filename,
            "Secret",
            maskSecretValue(rawSecret),
          );

          lineFinding = {
            type: "Secret",
            severity: family.severity,
            description: `Deterministic detection: ${family.name} leaked in added line.`,
            fileLocation: filename,
            codeSnippet: content,
            lineStart: line.number,
            lineEnd: line.number,
            dynamicFingerprint: dynFp.fingerprint,
            signatureVersion: dynFp.signatureVersion,
            matchedSignatures: [family.id],
            isZeroDay: false,
          };
        }
      }
    }

    if (lineFinding && detectedSecretsInLine.length > 0) {
      lineFinding.codeSnippet = maskSnippet(content, detectedSecretsInLine);
      findings.push(lineFinding);
    }
  }

  return findings;
}

/**
 * Extracts added lines from a patch string.
 * Uses unified diff parser when hunk headers are present, or falls back to
 * line-by-line inspection of added lines (+).
 */
export function extractAddedLinesFromPatch(
  patch: string,
): Array<{ number: number; content: string }> {
  if (!patch) return [];

  if (patch.includes("@@")) {
    const parsed = parseUnifiedPatch(patch);
    return addedLines(parsed);
  }

  // Fallback for bare diffs without standard hunk headers
  const lines = patch.split("\n");
  const result: Array<{ number: number; content: string }> = [];
  let lineNum = 1;

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
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
 * Scans a file's unified diff patch for secrets.
 */
export function detectSecretsInPatch(
  filename: string,
  patch: string,
  customPlaceholders: string[] = [],
): ScanFinding[] {
  const added = extractAddedLinesFromPatch(patch);
  return detectSecretsInAddedLines(filename, added, customPlaceholders);
}

/**
 * Scans all modified files from a pull request.
 */
export function detectSecretsInFiles(
  files: FileChange[],
  customPlaceholders: string[] = [],
): ScanFinding[] {
  const allFindings: ScanFinding[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    const findings = detectSecretsInPatch(file.filename, file.patch, customPlaceholders);
    allFindings.push(...findings);
  }
  return allFindings;
}

/**
 * Merges deterministic findings with LLM scan findings, dropping any duplicates
 * on the same file and lineStart. Deterministic findings take priority.
 */
export function mergeFindings(
  deterministic: ScanFinding[],
  llmFindings: ScanFinding[],
): ScanFinding[] {
  const seen = new Set<string>();
  const merged: ScanFinding[] = [];

  // Deterministic findings take priority
  for (const f of deterministic) {
    const key = `${f.fileLocation}:${f.lineStart ?? 0}`;
    seen.add(key);
    merged.push(f);
  }

  // Add LLM findings that don't collide on the same file and line
  for (const f of llmFindings) {
    const key = `${f.fileLocation}:${f.lineStart ?? 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(f);
    }
  }

  return merged;
}
