/**
 * Deterministic Secret Pre-Scanner (#1592)
 *
 * Fast, pure, deterministic pre-scan stage running before LLM analysis.
 * Operates purely on diffs / added lines, ignores removed/context lines,
 * respects existing ignore filters and placeholder heuristics, redacts
 * all emitted secrets to maximum 4 leading characters, and merges/deduplicates
 * with LLM results.
 */

import {
  SECRET_FAMILIES,
  isPlaceholder,
  shannonEntropy,
  ASSIGNMENT_MIN_ENTROPY,
  type SecretFamily,
} from "./secret-detector";
import { parseUnifiedPatch, addedLines } from "./diff";
import { computeDynamicFingerprint } from "./fingerprint";
import { ignoreReasonFor, compileIgnorePatterns } from "./ignore-rules";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "./scanner";

export interface PrecheckOptions {
  customPlaceholders?: string[];
  customIgnores?: string[];
  repositoryId?: string;
}

/**
 * Redacts a detected raw secret string:
 * Retains at most the first 4 characters followed by a mask.
 * Full secret value is never persisted or emitted.
 */
export function redactSecret(secret: string): string {
  if (!secret) return "";
  if (secret.startsWith("-----BEGIN")) {
    return "-----BEGIN PRIVATE KEY [REDACTED]-----";
  }
  const prefixLen = Math.min(4, secret.length);
  return `${secret.slice(0, prefixLen)}...[REDACTED]`;
}

/**
 * Redacts secret occurrences within a source line snippet.
 */
export function redactSnippetLine(line: string, rawSecrets: string[]): string {
  let redacted = line;
  for (const raw of rawSecrets) {
    if (raw && redacted.includes(raw)) {
      redacted = redacted.split(raw).join(redactSecret(raw));
    }
  }
  return redacted;
}

/**
 * Extracts added lines from a patch string.
 * Strictly ignores removed lines (-) and context lines.
 */
export function extractAddedLinesOnly(patch: string): Array<{ number: number; content: string }> {
  if (!patch) return [];

  if (patch.includes("@@")) {
    const parsed = parseUnifiedPatch(patch);
    return addedLines(parsed);
  }

  // Fallback line parser for diffs without hunk headers
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
 * Pure function: Scans a single file's patch for deterministic secrets.
 */
export function precheckFilePatch(
  filename: string,
  patch: string,
  options: PrecheckOptions = {},
): ScanFinding[] {
  const { customPlaceholders = [], customIgnores = [], repositoryId = "default-repo" } = options;

  // Respect custom ignores from .secureflowignore, but continue running
  // deterministic pre-scan on files skipped from LLM scanning by default patterns (#1983).
  const compiledIgnores = compileIgnorePatterns(customIgnores);
  const forCustom = filename.replace(/\\/g, "/");
  if (compiledIgnores.some((pattern) => pattern.test(forCustom))) {
    return [];
  }

  const added = extractAddedLinesOnly(patch);
  const findings: ScanFinding[] = [];

  for (const line of added) {
    const content = line.content;
    const detectedInLine: string[] = [];
    let activeFinding: ScanFinding | null = null;

    for (const family of SECRET_FAMILIES) {
      family.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = family.pattern.exec(content)) !== null) {
        const rawSecret = family.extractValue ? family.extractValue(match) : match[0];

        // Filter out obvious placeholders and documentation samples
        if (isPlaceholder(rawSecret, customPlaceholders)) {
          continue;
        }

        // Validate Shannon entropy for quoted generic assignments
        if (
          family.id === "quoted-secret-assignment" &&
          shannonEntropy(rawSecret) < ASSIGNMENT_MIN_ENTROPY
        ) {
          continue;
        }

        detectedInLine.push(rawSecret);

        if (!activeFinding) {
          const redacted = redactSecret(rawSecret);
          const dynFp = computeDynamicFingerprint(repositoryId, filename, "Secret", redacted);
          const detected = detectFileLanguage(filename, patch);

          activeFinding = {
            type: "Secret",
            severity: family.severity,
            confidence: "HIGH",
            confidenceReason: `Deterministic pre-scan: ${family.name} pattern match.`,
            description: `Deterministic pre-scan: ${family.name} detected on line ${line.number}.`,
            fileLocation: filename,
            codeSnippet: content,
            lineStart: line.number,
            lineEnd: line.number,
            dynamicFingerprint: dynFp.fingerprint,
            signatureVersion: dynFp.signatureVersion,
            matchedSignatures: [family.id, "precheck-deterministic"],
            isZeroDay: false,
            language: detected.language,
            ...(detected.framework ? { framework: detected.framework } : {}),
          };
        }
      }
    }

    if (activeFinding && detectedInLine.length > 0) {
      activeFinding.codeSnippet = redactSnippetLine(content, detectedInLine);
      findings.push(activeFinding);
    }
  }

  return findings;
}

/**
 * Pure function taking diff changes and returning deterministic findings.
 * Reuses existing `ScanFinding` types without parallel formats.
 */
export function runDeterministicPrecheck(
  files: FileChange[],
  options: PrecheckOptions = {},
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const file of files) {
    if (!file.patch || !file.patch.trim()) continue;
    const fileFindings = precheckFilePatch(file.filename, file.patch, options);
    findings.push(...fileFindings);
  }
  return findings;
}

/**
 * Deduplicates and merges precheck and deterministic findings with LLM scan findings.
 * If both report on the same file and line, or share a dynamic/standard fingerprint,
 * deterministic findings take priority and duplicate LLM findings are avoided.
 */
export function mergePrecheckWithLlmFindings(
  precheckFindings: ScanFinding[],
  llmFindings: ScanFinding[],
): ScanFinding[] {
  const seenLocations = new Set<string>();
  const seenFingerprints = new Set<string>();
  const merged: ScanFinding[] = [];

  for (const f of precheckFindings) {
    const key = `${f.fileLocation}:${f.lineStart ?? 0}`;
    seenLocations.add(key);
    if (f.dynamicFingerprint) {
      seenFingerprints.add(f.dynamicFingerprint);
    }
    const standardFp = (f as { fingerprint?: string }).fingerprint;
    if (standardFp) {
      seenFingerprints.add(standardFp);
    }
    merged.push(f);
  }

  for (const f of llmFindings) {
    const key = `${f.fileLocation}:${f.lineStart ?? 0}`;
    const dynFp = f.dynamicFingerprint;
    const standardFp = (f as { fingerprint?: string }).fingerprint;

    const isDuplicate =
      seenLocations.has(key) ||
      (dynFp !== undefined && seenFingerprints.has(dynFp)) ||
      (standardFp !== undefined && seenFingerprints.has(standardFp));

    if (!isDuplicate) {
      seenLocations.add(key);
      if (dynFp) seenFingerprints.add(dynFp);
      if (standardFp) seenFingerprints.add(standardFp);
      merged.push(f);
    }
  }

  return merged;
}
