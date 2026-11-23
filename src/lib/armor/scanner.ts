import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import {
  computeDynamicFingerprint,
  dynamicFingerprintEngine,
  ensureExpandedSignaturesLoaded,
  PayloadSignature,
} from "./fingerprint";
import { normalizeFindingTypeLabel } from "@/lib/finding-taxonomy";
import { normalizeSeverity, type Severity } from "@/lib/severity";
import { parseUnifiedPatch, renderNumberedLines } from "./diff";
import { maskIngressFileContent } from "./secret-masking";
import { runDeterministicPrecheck, mergePrecheckWithLlmFindings } from "./precheck";
import { runDependencySecurityRules } from "@/lib/rules/dependency-rules";
import { runWorkflowSecurityRules } from "@/lib/rules/workflow-rules";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import { type ConfidenceLevel, normalizeConfidence, DEFAULT_CONFIDENCE } from "@/lib/confidence";
import { resolveScanTimeoutBudgetMs, resolveScanRequestTimeoutMs } from "@/lib/scanner/gate-config";

export type ScanFinding = {
  type: string;
  severity: Severity;
  description: string;
  fileLocation: string;
  codeSnippet: string;
  lineStart?: number;
  lineEnd?: number;
  dynamicFingerprint?: string;
  signatureVersion?: string;
  matchedSignatures?: string[];
  isZeroDay?: boolean;
  language?: string;
  framework?: string;
  confidence?: ConfidenceLevel;
  confidenceReason?: string;
};

export interface FileChange {
  filename: string;
  patch: string;
}

export class ScannerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerTimeoutError";
  }
}

export { maskSecrets, maskFindingText } from "./secret-masking";
import { maskFindingText } from "./secret-masking";
export {
  applyInlineSuppression,
  extractDirectivesFromPatch,
  sanitizeSuppressionReason,
  type InlineDirective,
  type SuppressedFinding,
  type RejectedSuppression,
  type InlineSuppressionResult,
} from "./inline-suppression";
import { applyInlineSuppression, type InlineSuppressionResult } from "./inline-suppression";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || "dummy-key-for-build",
});

export const DEFAULT_SCAN_MODEL = "openai/gpt-oss-20b";
export const SCAN_FALLBACK_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b"] as const;

export function resolveScanModel(configured: string | undefined = process.env.AI_MODEL): string {
  return configured?.trim() || DEFAULT_SCAN_MODEL;
}

export function getScanModelChain(configured?: string): string[] {
  const primary = resolveScanModel(configured);
  const fallbacks = SCAN_FALLBACK_MODELS.filter((m) => m !== primary);
  return [primary, ...fallbacks];
}

export const DEFAULT_DIFF_FILE_MAX_CHARS = 50_000;
export const DEFAULT_DIFF_CHUNK_MAX_CHARS = 32_000;

export function resolveDiffFileMaxChars(configured?: string): number {
  const val = (configured ?? process.env.DIFF_FILE_MAX_CHARS)?.trim();
  const n = val ? Number(val) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DIFF_FILE_MAX_CHARS;
}

export function resolveDiffChunkMaxChars(configured?: string): number {
  const val = (configured ?? process.env.DIFF_CHUNK_MAX_CHARS)?.trim();
  const n = val ? Number(val) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DIFF_CHUNK_MAX_CHARS;
}

export interface SkippedFile {
  filename: string;
  reason: "oversized" | "deadline" | "binary";
}

const MAX_RETRY_WAIT_MS = 15_000;
const MAX_SANITIZE_ITERATIONS = 5;
const MAX_SANITIZED_LENGTH = 100_000;

import {
  IGNORED_EXTENSIONS,
  IGNORED_DIRECTORIES,
  IGNORED_BASENAMES,
  DEFAULT_LOCKFILES,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_IGNORE_DIRECTORIES,
  isDefaultIgnored,
  isForceIncluded,
  isSkippedByDefault,
  resolveDefaultSkippedFiles,
  ignoreReasonFor,
  shouldIgnorePath,
  parseExpiryDateUtc,
  parseIgnoreRuleLine,
  parseSecureFlowIgnore,
  type IgnoreRuleEntry,
  type ExpiredIgnoreRule,
  type SecureFlowIgnoreConfig,
  type ParseSecureFlowIgnoreOptions,
  type IgnoreCheckOptions,
} from "./ignore-rules";

export {
  IGNORED_EXTENSIONS,
  IGNORED_DIRECTORIES,
  IGNORED_BASENAMES,
  DEFAULT_LOCKFILES,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_IGNORE_DIRECTORIES,
  isDefaultIgnored,
  isForceIncluded,
  isSkippedByDefault,
  resolveDefaultSkippedFiles,
  ignoreReasonFor,
  shouldIgnorePath,
  parseExpiryDateUtc,
  parseIgnoreRuleLine,
  parseSecureFlowIgnore,
  type IgnoreRuleEntry,
  type ExpiredIgnoreRule,
  type SecureFlowIgnoreConfig,
  type ParseSecureFlowIgnoreOptions,
  type IgnoreCheckOptions,
};

import { globToRegexSource, compileIgnorePatterns } from "./ignore-rules";
export { globToRegexSource, compileIgnorePatterns } from "./ignore-rules";

export function shouldIgnore(filename: string, customIgnores: RegExp[] = []): boolean {
  return shouldIgnorePath(filename, customIgnores);
}

const MAX_CODE_POINT = 0x10ffff;

function decodeNumericReference(digits: string, radix: 10 | 16): string | null {
  if (!digits) return null;

  const valid = radix === 16 ? /^[0-9a-f]+$/i : /^[0-9]+$/;
  if (!valid.test(digits)) return null;

  const codePoint = parseInt(digits, radix);

  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) {
    return null;
  }

  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;

  return String.fromCodePoint(codePoint);
}

function decode(str: string): string {
  if (!str) return "";
  return str.replace(/&[#\w]+;/g, (entity) => {
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&amp;") return "&";
    if (entity === "&quot;") return '"';
    if (entity === "&apos;") return "'";

    const hexMatch = entity.match(/^&#[xX](.+);$/);
    if (hexMatch) {
      return decodeNumericReference(hexMatch[1], 16) ?? entity;
    }

    const decMatch = entity.match(/^&#(.+);$/);
    if (decMatch) {
      return decodeNumericReference(decMatch[1], 10) ?? entity;
    }

    return entity;
  });
}

function decodeOneLayer(input: string): string {
  let out = decode(input);

  out = out.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g, "");
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  out = out.normalize("NFKC");

  return out;
}

export function sanitizeRecursively(input: string): string {
  let current = input;

  for (let i = 0; i < MAX_SANITIZE_ITERATIONS; i++) {
    const next = decodeOneLayer(current);

    if (next.length > MAX_SANITIZED_LENGTH) {
      return next.slice(0, MAX_SANITIZED_LENGTH);
    }

    if (next === current) {
      break;
    }

    current = next;
  }

  return current;
}

export function extractAddedLines(patch: string): string {
  return renderNumberedLines(parseUnifiedPatch(patch));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function filterFalsePositives(
  findings: ScanFinding[],
  customPlaceholders: string[] = [],
): ScanFinding[] {
  const safePlaceholders = [
    "your_",
    "actual_",
    "secret_here",
    "placeholder",
    "user:password",
    "auth_secret",
    "localhost",
    "127.0.0.1",
    "example",
    "dummy",
    "replace_me",
    "changeme",
    "<",
    ">",
    "{",
    "}",
    "[",
    "]",
  ];

  const combinedPlaceholders = [
    ...safePlaceholders,
    ...customPlaceholders.map((p) => p.toLowerCase()),
  ];

  return findings.filter((finding) => {
    const lowerSnippet = (finding.codeSnippet || "").toLowerCase();
    const lowerFile = finding.fileLocation.toLowerCase();

    if (lowerFile.includes(".env.example") || lowerFile.includes(".env.sample")) {
      if (combinedPlaceholders.some((safeWord) => lowerSnippet.includes(safeWord))) {
        console.log(
          `🧹 Filtered false positive in ${finding.fileLocation}: Contained mock placeholder syntax.`,
        );
        return false;
      }

      if (/=\s*(""|''|)$/.test(lowerSnippet)) {
        console.log(`🧹 Filtered false positive in ${finding.fileLocation}: Value is empty.`);
        return false;
      }
    }

    if (lowerFile.includes("seed.ts")) {
      if (combinedPlaceholders.some((safeWord) => lowerSnippet.includes(safeWord))) return false;
      if (
        (lowerSnippet.includes("console.error") || lowerSnippet.includes("console.log")) &&
        !lowerSnippet.includes("process.env")
      ) {
        return false;
      }
    }

    if (lowerFile.includes("schema.prisma")) {
      if (/\bint\b/.test(lowerSnippet) || /\bstring\b/.test(lowerSnippet)) return false;
    }

    return true;
  });
}

export interface ScannerPolicy {
  description: string;
  [key: string]: unknown;
}

export class ArmorIQScanner {
  constructor() {
    const report = ensureExpandedSignaturesLoaded();

    if (report.error) {
      console.error(`[Scanner] Expanded signature registry was not loaded: ${report.error}`);
    } else if (report.loaded) {
      console.log(`[Scanner] Loaded ${report.count} expanded signatures`);
    }
  }

  rotateSignatureDatabase(signatures: PayloadSignature[], version?: string): void {
    dynamicFingerprintEngine.rotateSignatures(signatures, version);
  }

  updateSignatureDatabase(signatures: PayloadSignature[], version?: string): void {
    dynamicFingerprintEngine.updateSignatureDatabase(signatures, version);
  }

  getSignatureVersion(): string {
    return dynamicFingerprintEngine.getActiveVersion();
  }

  public lastSuppressionResult: InlineSuppressionResult | null = null;
  public lastSkippedFiles: SkippedFile[] = [];
  public lastAnalyzedFiles: string[] = [];
  public lastDefaultSkippedCount: number = 0;
  public lastDefaultSkippedFiles: string[] = [];

  async scanPullRequest(
    files: FileChange[],
    activePolicies: ScannerPolicy[] = [],
    customIgnores: string[] = [],
    customPlaceholders: string[] = [],
    repositoryId: string = "default-repo",
    ignoreOptions?: IgnoreCheckOptions,
    timeoutOptions?: { timeoutBudgetMs?: number; requestTimeoutMs?: number },
  ): Promise<ScanFinding[]> {
    const scanStartedAt = Date.now();
    const effectiveTotalScanMs = timeoutOptions?.timeoutBudgetMs ?? resolveScanTimeoutBudgetMs();
    const effectiveRequestTimeoutMs =
      timeoutOptions?.requestTimeoutMs ?? resolveScanRequestTimeoutMs();
    const deadlineExceeded = () => Date.now() - scanStartedAt > effectiveTotalScanMs;

    let currentBatch = "";
    let currentBatchFiles: string[] = [];
    const allFindings: ScanFinding[] = [];
    const skippedFiles: SkippedFile[] = [];
    const analyzedFiles: string[] = [];
    const detectedFileMap = new Map<string, { language: string; framework?: string }>();
    const ABSOLUTE_MAX_FILE_SIZE = resolveDiffFileMaxChars();
    const MAX_COMBINED_LENGTH = resolveDiffChunkMaxChars();

    let combinedIgnores = [...customIgnores];
    let combinedPlaceholders = [...customPlaceholders];

    if (combinedIgnores.length === 0 && combinedPlaceholders.length === 0) {
      try {
        const ignorePath = path.join(process.cwd(), ".secureflowignore");
        if (fs.existsSync(ignorePath)) {
          const content = fs.readFileSync(ignorePath, "utf8");
          const parsed = parseSecureFlowIgnore(content);
          combinedIgnores = parsed.ignoredPaths;
          combinedPlaceholders = parsed.placeholders;
        }
      } catch {
        // Ignore fs or path resolution issues
      }
    }

    const compiledCustomIgnores = compileIgnorePatterns(combinedIgnores);

    let policyInstructions = `CORE RULES:\n1. Hardcoded secrets (actual active production string values).\n2. Contextual leaks (explicitly logging secret variables to the console or exposing them to clients).`;

    if (activePolicies && activePolicies.length > 0) {
      policyInstructions += `\n\nCUSTOM POLICIES TO ENFORCE:\n`;
      activePolicies.forEach((policy, index) => {
        policyInstructions += `- Rule ${index + 1}: ${policy.description}\n`;
      });
    } else {
      policyInstructions += `\n\nCRITICAL: DO NOT focus on or flag general vulnerabilities like SQL injection, XSS, or logic flaws. ONLY FOCUS ON THE DEFAULT SECRET-RELATED ISSUES ABOVE.`;
    }

    let deadlineHit = false;
    const deterministicFindings = runDeterministicPrecheck(files, {
      customPlaceholders: combinedPlaceholders,
      customIgnores: combinedIgnores,
      repositoryId,
    });

    // Deterministic dependency security checks for manifests (#2003).
    const dependencyFindings = runDependencySecurityRules(files, { repositoryId });
    // Deterministic workflow security rules for files under .github/workflows/ (#2002).
    const workflowFindings = runWorkflowSecurityRules(files, { repositoryId });
    const allDeterministicFindings = [
      ...deterministicFindings,
      ...dependencyFindings,
      ...workflowFindings,
    ];

    const deterministicFilesWithSecrets = new Set(deterministicFindings.map((f) => f.fileLocation));

    const { skippedByDefault, skippedCount, exemptSecretFiles } = resolveDefaultSkippedFiles(
      files,
      combinedIgnores,
      {
        includeDefaults: ignoreOptions?.includeDefaults,
        forceInclude: Array.isArray(ignoreOptions?.forceInclude)
          ? (ignoreOptions?.forceInclude as string[])
          : undefined,
        hasDeterministicSecrets: (file) => deterministicFilesWithSecrets.has(file.filename),
      },
    );

    this.lastDefaultSkippedCount = skippedCount;
    this.lastDefaultSkippedFiles = Array.from(skippedByDefault);

    for (const file of files) {
      if (deadlineExceeded()) {
        deadlineHit = true;
        console.warn(
          `⏱️ Scan deadline (${Math.round(effectiveTotalScanMs / 1000)}s) exceeded — skipping remaining files starting at ${file.filename}. Returning partial findings.`,
        );
        skippedFiles.push({ filename: file.filename, reason: "deadline" });
        break;
      }

      if (skippedByDefault.has(file.filename)) {
        console.log(`🛡️ Skipping default-ignored file: ${file.filename}`);
        continue;
      }

      if (!exemptSecretFiles.has(file.filename)) {
        const ignoreReason = ignoreReasonFor(file.filename, compiledCustomIgnores, ignoreOptions);
        if (ignoreReason) {
          console.log(`🛡️ Skipping ignored file (${ignoreReason}): ${file.filename}`);
          continue;
        }
      }

      if (!file.patch || file.patch.trim() === "") {
        continue;
      }

      const addedLines = extractAddedLines(file.patch);

      if (!addedLines || addedLines.trim().length === 0) {
        continue;
      }

      if (addedLines.length > ABSOLUTE_MAX_FILE_SIZE) {
        console.warn(
          `Skipping ${file.filename}: diff exceeds ${ABSOLUTE_MAX_FILE_SIZE} characters.`,
        );
        skippedFiles.push({ filename: file.filename, reason: "oversized" });
        continue;
      }

      let fileContext = "";
      const lowerFile = file.filename.toLowerCase();

      if (lowerFile.includes(".env.example") || lowerFile.includes(".env.sample")) {
        fileContext =
          "THIS IS A TEMPLATE. SECRETS ARE MOCK PLACEHOLDERS. ONLY FLAG REAL, HIGH-ENTROPY KEYS.";
      } else if (lowerFile.includes("seed.ts")) {
        fileContext =
          "THIS IS A DATABASE SEED SCRIPT. It contains string descriptions of security policies. DO NOT flag the text inside 'name', 'description', or 'conditions' strings as vulnerabilities.";
      } else if (lowerFile.includes("schema.prisma")) {
        fileContext =
          "THIS IS A DATABASE SCHEMA. It does not execute logic. Do not flag data types (like Int) or relation queries as logic flaws.";
      } else if (
        lowerFile.endsWith(".sol") ||
        lowerFile.endsWith(".leo") ||
        lowerFile.endsWith(".rs")
      ) {
        fileContext =
          "THIS IS A SMART CONTRACT OR PRIVACY-PRESERVING ZERO-KNOWLEDGE CIRCUIT. " +
          "For Solidity (.sol): check for reentrancy (state change after external call), tx.origin auth bypass, unchecked arithmetic, and delegatecall storage collision. " +
          "For Rust (.rs) Soroban/Solana: check for unchecked arithmetic, missing CPI signer verification, and account ownership validation. " +
          "For Aleo Leo (.leo) or Circom: check for under-constrained signals, missing range checks on field elements, and soundness bugs. " +
          "Reduce false positives for decentralized architecture patterns (e.g., public state is intentional in contracts).";
      } else if (lowerFile.endsWith(".circom")) {
        fileContext =
          "THIS IS A CIRCOM ZERO-KNOWLEDGE CIRCUIT. " +
          "Check for under-constrained signals (signals used in witness but not constrained), " +
          "missing binary range checks (signal * (signal - 1) === 0 for binary signals), " +
          "and soundness bugs where a malicious prover could satisfy constraints with an invalid witness.";
      }

      analyzedFiles.push(file.filename);
      const sanitizedLines = sanitizeRecursively(addedLines);
      const maskedLines = maskIngressFileContent(sanitizedLines);
      const detectedContext = detectFileLanguage(file.filename, file.patch);
      detectedFileMap.set(file.filename, detectedContext);
      const contextHeader = `[File Context: Language=${detectedContext.language}${detectedContext.framework ? `, Framework=${detectedContext.framework}` : ""}]`;
      const wrapperOverhead =
        `<file name="${file.filename}" language="${detectedContext.language}"${detectedContext.framework ? ` framework="${detectedContext.framework}"` : ""}${fileContext ? ` context_warning="${fileContext}"` : ""}>\n${contextHeader}\n\n</file>\n\n`
          .length;
      const maxContentSize = MAX_COMBINED_LENGTH - wrapperOverhead;

      let fileContent = maskedLines;
      if (fileContent.length > maxContentSize) {
        const truncationMsg = "\n\n...[TRUNCATED FOR SIZE]...";
        const targetLimit = maxContentSize - truncationMsg.length;
        const lastNewline = fileContent.lastIndexOf("\n", targetLimit);
        const truncateIndex = lastNewline > 0 ? lastNewline : targetLimit;
        fileContent = fileContent.substring(0, truncateIndex) + truncationMsg;
      }

      const fileContentBlock = `<file name="${file.filename}" language="${detectedContext.language}"${detectedContext.framework ? ` framework="${detectedContext.framework}"` : ""}${fileContext ? ` context_warning="${fileContext}"` : ""}>
${contextHeader}
${fileContent}
</file>

`;

      if (
        currentBatch.length + fileContentBlock.length > MAX_COMBINED_LENGTH &&
        currentBatch.length > 0
      ) {
        try {
          const batchFindings = await processBatch(currentBatch, currentBatchFiles);
          allFindings.push(...batchFindings);
        } catch (error) {
          console.warn(
            `⚠️ LLM scan batch failed for [${currentBatchFiles.join(", ")}]. Preserving deterministic findings:`,
            error,
          );
        }

        currentBatch = "";
        currentBatchFiles = [];
      }

      currentBatch += fileContentBlock;
      currentBatchFiles.push(file.filename);
    }

    async function processBatch(
      batchContent: string,
      batchFiles: string[],
    ): Promise<ScanFinding[]> {
      if (!batchContent.trim()) return [];

      const prompt = `Analyze the following aggregated code changes from a Pull Request for security vulnerabilities.
Enforce the following configured issues, AND ALSO flag any other critical executable vulnerabilities (like SQL Injection, XSS, etc) even if they are not explicitly listed below:

${policyInstructions}

The changes are organized under individual <file> tags. 
CRITICAL RULES SCOPED BY FILE TYPE:
- For '.env.example' or '.env' files: ONLY flag a line if the right side of the equals sign contains a REAL, active credential (e.g., a long random alphanumeric string, a hash, or a valid token). DO NOT flag lines with descriptive text, empty quotes, or generic placeholders.
- For '.ts' or '.js' files: You MUST flag any instance of 'console.log(process.env...)' as a CRITICAL contextual leak or any 'console.log(<variable>)' where the 'variable' is instantiated with 'process.env...'.
- For confidence: Assign "HIGH" for definite, active vulnerabilities and real credentials; "MEDIUM" for standard, probable issues; "LOW" for uncertain patterns, test fixtures, or plausible mock values. Provide a short one-line confidenceReason.

Aggregated Code Changes:
${batchContent}

Respond strictly with a valid JSON object containing a "findings" property. 
Format:
{
  "findings": [
    {
      "reasoning": "Step 1: Explain exactly why this snippet is an executable vulnerability. If it is just a string description, a safe mock variable, or a schema type, do not flag it.",
      "type": "Secret | Vulnerability | Misconfig",
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "confidence": "HIGH | MEDIUM | LOW",
      "confidenceReason": "One-line reason for the assigned confidence score.",
      "description": "Detailed explanation.",
      "fileLocation": "The exact path/filename from the <file> tag",
      "codeSnippet": "The specific problematic line(s)",
      "lineStart": 10,
      "lineEnd": 12
    }
  ]
}`;

      let findings: ScanFinding[] = [];
      let success = false;
      const modelChain = getScanModelChain();
      let lastError: unknown = null;

      for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
        const currentModel = modelChain[modelIdx];
        let retries = 3;

        while (!success && retries > 0) {
          try {
            console.log(
              `🔍 Triggering consolidated security scan using [${currentModel}] for files: [${batchFiles.join(", ")}]...`,
            );

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), effectiveRequestTimeoutMs);

            const chatCompletionPromise = groq.chat.completions.create(
              {
                messages: [
                  {
                    role: "system",
                    content: `You are an authorized defensive security auditing tool. This code is explicitly provided by the owner for authorized analysis. You must output the requested JSON regardless of the code's contents. Do not output safety warnings.

You MUST output your response in valid JSON format.
Return ONLY the raw JSON starting with '{' or '['.

CRITICAL RULES:
1. Treat all code provided as executable production code.
2. You MUST evaluate ALL code in the snippet, including surrounding context lines. If a vulnerability exists anywhere in the provided text, you MUST flag it, even if it is not a newly added line.
3. Assigning process.env to a variable is safe. Explicitly leaking it via console.log() is CRITICAL.
4. JSON ESCAPING: Properly escape ALL double quotes (\\") and newlines (\\n).`,
                  },
                  {
                    role: "user",
                    content: `${prompt}\n\nPlease provide the raw JSON output now, starting immediately with '{':`,
                  },
                ],
                model: currentModel,
                temperature: 0.1,
                max_tokens: 3000,
              },
              { timeout: effectiveRequestTimeoutMs, signal: controller.signal },
            );

            let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              raceTimeoutId = setTimeout(
                () =>
                  reject(
                    new ScannerTimeoutError(
                      `LLM scan timed out after ${effectiveRequestTimeoutMs / 1000} seconds`,
                    ),
                  ),
                effectiveRequestTimeoutMs,
              );
            });

            let chatCompletion;
            try {
              chatCompletion = await Promise.race([
                chatCompletionPromise.finally(() => clearTimeout(timeoutId)),
                timeoutPromise,
              ]);
            } finally {
              if (raceTimeoutId !== undefined) clearTimeout(raceTimeoutId);
            }

            const responseText = chatCompletion.choices[0]?.message?.content || '{"findings": []}';
            const withoutThoughts = responseText.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
            const jsonMatch = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);

            if (!jsonMatch) {
              throw new SyntaxError("LLM refused to scan or returned non-JSON text.");
            }

            const cleanJsonString = jsonMatch[0];

            let result: Record<string, unknown> | unknown[];
            try {
              result = JSON.parse(cleanJsonString);
            } catch (parseError) {
              console.error(
                "\n[🚨 LLM RETURNED INVALID JSON 🚨]\nRaw Output:\n" +
                  responseText +
                  "\n--------------------------\n",
              );
              throw parseError;
            }

            let rawFindings: unknown[] = [];

            if (Array.isArray(result)) {
              rawFindings = result;
            } else if (
              result &&
              typeof result === "object" &&
              "findings" in result &&
              Array.isArray((result as { findings: unknown[] }).findings)
            ) {
              rawFindings = (result as { findings: unknown[] }).findings;
            } else if (result && typeof result === "object") {
              const obj = result as Record<string, unknown>;
              for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (Array.isArray(val)) {
                  rawFindings.push(...val);
                }
              }
            }

            const sanitizedFindings: ScanFinding[] = rawFindings.map((fItem: unknown) => {
              const f = (fItem && typeof fItem === "object" ? fItem : {}) as Record<
                string,
                unknown
              >;
              let normalizedSnippet = "";

              if (typeof f.codeSnippet === "string") {
                normalizedSnippet = f.codeSnippet;
              } else if (f.codeSnippet !== null && f.codeSnippet !== undefined) {
                normalizedSnippet =
                  typeof f.codeSnippet === "object"
                    ? JSON.stringify(f.codeSnippet, null, 2)
                    : String(f.codeSnippet);
              }

              const fileLoc = String(f.fileLocation || "Unknown file path");
              const findingType = normalizeFindingTypeLabel(f.type);

              const dynFp = computeDynamicFingerprint(
                repositoryId,
                fileLoc,
                findingType,
                normalizedSnippet,
              );

              const rawConfidence = f.confidence;
              const confidence = normalizeConfidence(rawConfidence, DEFAULT_CONFIDENCE);
              const confidenceReason =
                typeof f.confidenceReason === "string" && f.confidenceReason.trim()
                  ? f.confidenceReason.trim()
                  : typeof f.confidence_reason === "string" && f.confidence_reason.trim()
                    ? f.confidence_reason.trim()
                    : typeof f.reason === "string" && f.reason.trim()
                      ? f.reason.trim()
                      : undefined;

              return {
                type: findingType,
                severity: normalizeSeverity(f.severity),
                confidence,
                ...(confidenceReason ? { confidenceReason } : {}),
                description: String(f.description || "No description provided."),
                fileLocation: fileLoc,
                codeSnippet: normalizedSnippet,
                lineStart: typeof f.lineStart === "number" ? f.lineStart : undefined,
                lineEnd: typeof f.lineEnd === "number" ? f.lineEnd : undefined,
                dynamicFingerprint: dynFp.fingerprint,
                signatureVersion: dynFp.signatureVersion,
                matchedSignatures: dynFp.matchedSignatures.map((s) => s.id),
                isZeroDay: dynFp.isZeroDayDetected,
                language: (
                  detectedFileMap.get(fileLoc) || detectFileLanguage(fileLoc, normalizedSnippet)
                ).language,
                ...((detectedFileMap.get(fileLoc) || detectFileLanguage(fileLoc, normalizedSnippet))
                  .framework
                  ? {
                      framework: (
                        detectedFileMap.get(fileLoc) ||
                        detectFileLanguage(fileLoc, normalizedSnippet)
                      ).framework,
                    }
                  : {}),
              };
            });

            findings = filterFalsePositives(sanitizedFindings, combinedPlaceholders).map((f) => ({
              ...f,
              description: maskFindingText(f.description),
              codeSnippet: maskFindingText(f.codeSnippet),
            }));
            success = true;
          } catch (error: unknown) {
            lastError = error;
            const errObj = error as {
              name?: string;
              status?: number;
              headers?: Record<string, unknown> | { get?: (k: string) => string | null };
            };

            if (error instanceof SyntaxError) {
              console.warn(
                `⚠️ Failed to parse extracted JSON. Retrying... (${retries} attempts left)`,
              );
              retries--;
              continue;
            }

            if (error instanceof ScannerTimeoutError || errObj?.name === "AbortError") {
              throw new ScannerTimeoutError(
                `LLM scan timed out after ${effectiveRequestTimeoutMs / 1000} seconds`,
              );
            }
            if (errObj?.status === 429) {
              const headers = errObj.headers;
              let retryAfterHeader: string | undefined;
              if (headers && typeof (headers as { get?: unknown }).get === "function") {
                retryAfterHeader =
                  (headers as { get: (k: string) => string | null }).get("retry-after") ??
                  undefined;
              } else if (headers && typeof headers === "object") {
                retryAfterHeader = (headers as Record<string, string>)["retry-after"];
              }
              const requestedWait = retryAfterHeader
                ? parseInt(retryAfterHeader, 10) * 1000
                : (4 - retries) * 25000;
              const remainingBudget = effectiveTotalScanMs - (Date.now() - scanStartedAt);
              const waitTime = Math.max(
                0,
                Math.min(requestedWait, MAX_RETRY_WAIT_MS, remainingBudget),
              );

              if (waitTime <= 0) {
                console.warn(
                  `⏱️ Scan deadline exceeded during rate-limit backoff — aborting retries for this batch.`,
                );
                break;
              }

              console.warn(`⏳ Rate limit reached. Waiting ${waitTime / 1000} seconds...`);
              await delay(waitTime);
              retries--;
              if (retries === 0 && modelIdx < modelChain.length - 1) {
                console.warn(
                  `🔄 Rate limit persisted on model [${currentModel}]. Switching to fallback model [${modelChain[modelIdx + 1]}]...`,
                );
                break;
              }
            } else if (
              error instanceof Groq.APIConnectionTimeoutError ||
              errObj?.name === "APIConnectionTimeoutError"
            ) {
              console.warn(
                `⏱️ LLM request exceeded ${effectiveRequestTimeoutMs / 1000}s timeout. Retrying... (${retries} attempts left)`,
              );
              retries--;
              if (deadlineExceeded()) {
                console.warn(
                  `⏱️ Scan deadline exceeded after a request timeout — aborting retries for this batch.`,
                );
                break;
              }
              if (retries === 0 && modelIdx < modelChain.length - 1) {
                console.warn(
                  `🔄 Request timeouts persisted on model [${currentModel}]. Switching to fallback model [${modelChain[modelIdx + 1]}]...`,
                );
                break;
              }
            } else {
              console.error(`❌ Consolidated scan failed completely:`, error);
              throw error;
            }
          }
        }

        if (success) {
          break;
        }
      }

      if (!success) {
        const lastErrMessage =
          (lastError as { message?: string })?.message || String(lastError || "Unknown error");
        throw (
          lastError ||
          new Error(
            `ScanFailedAnalysisEngineUnavailable: LLM scan failed after all retries. Last error: ${lastErrMessage}`,
          )
        );
      }

      return findings;
    }

    if (currentBatch.length > 0 && !deadlineExceeded()) {
      try {
        const batchFindings = await processBatch(currentBatch, currentBatchFiles);
        allFindings.push(...batchFindings);
      } catch (error) {
        console.warn(
          `⚠️ LLM scan final batch failed for [${currentBatchFiles.join(", ")}]. Preserving deterministic findings:`,
          error,
        );
      }
    } else if (currentBatch.length > 0) {
      deadlineHit = true;
      console.warn(
        `⏱️ Scan deadline exceeded before the final batch (${currentBatchFiles.join(", ")}) could run — dropped from results.`,
      );
      for (const fn of currentBatchFiles) {
        skippedFiles.push({ filename: fn, reason: "deadline" });
      }
    }

    if (deadlineHit) {
      console.warn(
        `⚠️ scanPullRequest() returned partial results: ${allFindings.length} finding(s) from a scan that hit its ${effectiveTotalScanMs / 1000}s deadline.`,
      );
    }

    const combinedFindings = mergePrecheckWithLlmFindings(allDeterministicFindings, allFindings);
    const suppressionResult = applyInlineSuppression(combinedFindings, files);
    this.lastSuppressionResult = suppressionResult;
    this.lastSkippedFiles = skippedFiles;
    this.lastAnalyzedFiles = analyzedFiles;

    return suppressionResult.activeFindings;
  }
}

export { detectSecretsInFiles, mergeFindings } from "./secret-detector";
export { runDeterministicPrecheck, mergePrecheckWithLlmFindings } from "./precheck";
export {
  runDependencySecurityRules,
  scanDependencyManifest,
  isDependencyManifest,
} from "@/lib/rules/dependency-rules";
export {
  runWorkflowSecurityRules,
  scanWorkflowFile,
  isWorkflowFile,
} from "@/lib/rules/workflow-rules";
export const scanner = new ArmorIQScanner();