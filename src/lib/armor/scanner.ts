import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import {
  computeDynamicFingerprint,
  dynamicFingerprintEngine,
  ensureExpandedSignaturesLoaded,
  PayloadSignature
} from './fingerprint';
import { normalizeFindingTypeLabel } from '@/lib/finding-taxonomy';
import { normalizeSeverity, type Severity } from '@/lib/severity';
import { parseUnifiedPatch, renderNumberedLines } from './diff';
import { ignoreReasonFor, shouldIgnorePath } from './ignore-rules';
import { maskIngressFileContent, maskSecrets } from './secret-masking';

export type ScanFinding = {
  type: string;
  /** Canonical severity — see `@/lib/severity` for parsing and ordering. */
  severity: Severity;
  description: string;
  fileLocation: string;
  codeSnippet: string;
  lineStart?: number;
  lineEnd?: number;
  dynamicFingerprint?: string;
  fingerprint?: string;
  explanation?: string;
  remediation?: string;
  promptInjectionSuspected?: boolean;
  signatureVersion?: string;
  matchedSignatures?: string[];
  isZeroDay?: boolean;
};

export interface FileChange {
  filename: string;
  patch: string;
}

export class ScannerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerTimeoutError';
  }
}

/**
 * Redact known secret formats and high-entropy strings.
 *
 * The rules moved to `./secret-masking` (#591). They were a wall of sequential
 * `.replace()` calls whose ordering was accidental — the `sk-proj-` rule sat
 * below the broader `sk-` rule and could never fire — and they were missing the
 * shapes that matter most: PEM private keys, `DB_PASSWORD = "…"` assignments,
 * non-URI connection strings, and the high-entropy check this comment used to
 * promise without implementing.
 *
 * Re-exported here so the ~10 existing importers and their tests are unchanged.
 */
export { maskSecrets, maskFindingText } from './secret-masking';
import { maskFindingText } from './secret-masking';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'dummy-key-for-build',
});

// --- Timeout / deadline guards -------------------------------------------------------------
// A single malformed or maliciously-crafted diff (e.g. one engineered to make the LLM hang,
// or a PR large enough to spawn many batches) must never be able to hang the scan indefinitely
// or exhaust memory. These bound worst-case behavior explicitly rather than relying on the
// HTTP client's own defaults (Groq's SDK default is 1 minute per request, with no cap at all
// on the number of batches a large PR can produce).
const SCAN_REQUEST_TIMEOUT_MS = 120_000; // hard cap per individual LLM call
const MAX_TOTAL_SCAN_MS = 300_000; // hard cap across the whole scanPullRequest() call
const MAX_RETRY_WAIT_MS = 15_000; // cap on any single rate-limit backoff wait

// --- Recursive sanitization guards ---------------------------------------------------------
// A single pass of `<`/`>` escaping can be defeated by nesting or stacking encodings (e.g.
// HTML-entity-encoded entities, unicode escape sequences, zero-width characters used to split
// up flagged keywords). sanitizeRecursively() normalizes until stable or these caps are hit,
// so the normalization loop itself can't become a new hang/memory vector.
const MAX_SANITIZE_ITERATIONS = 5;
const MAX_SANITIZED_LENGTH = 100_000;

// The ignore rules themselves moved to `./ignore-rules` (#704). They were three
// `.includes()` checks against the whole path, which is substring matching with
// no directory or filename boundary: `'build/'` also matched `prebuild/`,
// `'dist/'` also matched `redist/`, and `'package.json'` also matched
// `tools/package.json.generator.ts`. Every one of those files was dropped from
// the scan with no warning, and the pull request still got a clean report.
//
// Re-exported so the existing importers of the constants are unchanged.
export {
  IGNORED_EXTENSIONS,
  IGNORED_DIRECTORIES,
  IGNORED_BASENAMES,
  ignoreReasonFor,
} from './ignore-rules';

export interface SecureFlowIgnoreConfig {
  ignoredPaths: string[];
  placeholders: string[];
}

export function parseSecureFlowIgnore(content: string): SecureFlowIgnoreConfig {
  const ignoredPaths: string[] = [];
  const placeholders: string[] = [];
  let currentSection: 'paths' | 'placeholders' = 'paths';

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.toLowerCase() === '[placeholders]' || trimmed.toLowerCase() === '[mocks]') {
      currentSection = 'placeholders';
      continue;
    }

    if (trimmed.toLowerCase() === '[paths]' || trimmed.toLowerCase() === '[files]') {
      currentSection = 'paths';
      continue;
    }

    if (currentSection === 'placeholders') {
      placeholders.push(trimmed);
    } else {
      ignoredPaths.push(trimmed);
    }
  }

  return { ignoredPaths, placeholders };
}

export function compileIgnorePatterns(patterns: string[]): RegExp[] {
  return patterns
    .map(p => p.trim())
    .filter(p => p.length > 0 && !p.startsWith('#'))
    .map(p => {
      const pattern = p.replace(/\\/g, '/');
      const hasLeadingSlash = pattern.startsWith('/');
      const cleanPattern = hasLeadingSlash ? pattern.slice(1) : pattern;
      const patternWithoutTrailingSlash = cleanPattern.endsWith('/') ? cleanPattern.slice(0, -1) : cleanPattern;
      const isRootRelative = hasLeadingSlash || patternWithoutTrailingSlash.includes('/');
      
      let glob = cleanPattern;
      if (glob.endsWith('/')) {
        glob += '**';
      }
      
      // Escape regex characters except *, ?
      let regexStr = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      
      // Handle question marks first (before introducing any group (?) syntax)
      regexStr = regexStr.replace(/\?/g, '[^/]');
      
      // Handle double asterisks
      regexStr = regexStr.replace(/\/\*\*\//g, '/(?:.*/)?');
      regexStr = regexStr.replace(/\*\*\//g, '(?:.*/)?');
      regexStr = regexStr.replace(/\/\*\**/g, '(?:/.*)?');
      regexStr = regexStr.replace(/\*\*/g, '.*');
      
      // Handle single asterisks
      regexStr = regexStr.replace(/(?<!\.)\*(?!\.)/g, '[^/]*');
      
      if (isRootRelative) {
        return new RegExp(`^${regexStr}$`, 'i');
      } else {
        return new RegExp(`(^|/)${regexStr}$`, 'i');
      }
    });
}

/**
 * Whether the scanner should skip `filename`.
 *
 * Kept here with its original name and signature — roughly ten call sites and
 * their tests import it from this module — but the matching now lives in
 * `./ignore-rules`, where directory rules are matched on path segments and
 * configuration files on the basename. See that module for why the previous
 * substring matching was a security problem rather than a tidiness one.
 */
export function shouldIgnore(filename: string, customIgnores: RegExp[] = []): boolean {
  return shouldIgnorePath(filename, customIgnores);
}

/**
 * Highest code point Unicode defines. `String.fromCodePoint` throws a
 * RangeError above this, which would escape `sanitizeRecursively()`.
 */
const MAX_CODE_POINT = 0x10ffff;

/**
 * Turn a numeric character reference into its character, or `null` when the
 * reference is malformed and should be left alone.
 *
 * `String.fromCharCode(parseInt(...))` was wrong twice over: it truncates
 * astral code points (`&#x1F600;` became U+F600, a private-use glyph), and an
 * unparseable reference such as `&#xZZ;` produced `fromCharCode(NaN)` \u2014 a NUL
 * byte injected straight into the text handed to the model.
 */
function decodeNumericReference(digits: string, radix: 10 | 16): string | null {
  if (!digits) return null;

  const valid = radix === 16 ? /^[0-9a-f]+$/i : /^[0-9]+$/;
  if (!valid.test(digits)) return null;

  const codePoint = parseInt(digits, radix);

  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) {
    return null;
  }

  // Lone surrogates are not valid scalar values and corrupt downstream encoding.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;

  return String.fromCodePoint(codePoint);
}

function decode(str: string): string {
  if (!str) return '';
  return str.replace(/&[#\w]+;/g, (entity) => {
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&amp;') return '&';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";

    // `&#x41;` and `&#X41;` are both valid hexadecimal references.
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

  // Strip C0/C1 control characters (keeping tab, newline and carriage return).
  // A NUL or other control byte carries no meaning in source text but can be
  // used to split a flagged keyword apart, which is exactly what this
  // normalisation loop exists to prevent.
  out = out.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    ""
  );

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

/**
 * Turn a unified diff patch into the numbered snippet handed to the model.
 *
 * The parsing itself now lives in `./diff`, which the webhook worker reads too.
 * It used to live here, and the worker carried its own second implementation
 * that had never received any of the fixes this one accumulated — so the line
 * numbers the model was given and the line numbers a review comment could be
 * anchored on drifted apart inside the same hunk (#589). One parser, one
 * numbering, both callers.
 *
 * Emits added and context lines with their line number in the *new* file.
 * Deleted lines are skipped: they no longer exist in the merged result, and the
 * scan prompt instructs the model to flag anything it sees, so surfacing them
 * would produce findings against code the PR removes.
 */
export function extractAddedLines(patch: string): string {
  return renderNumberedLines(parseUnifiedPatch(patch));
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function filterFalsePositives(findings: ScanFinding[], customPlaceholders: string[] = []): ScanFinding[] {
  const safePlaceholders = [
    'your_', 'actual_', 'secret_here', 'placeholder', 
    'user:password', 'auth_secret', 'localhost', '127.0.0.1',
    'example', 'dummy', 'replace_me', 'changeme',
    '<', '>', '{', '}', '[', ']'
  ];

  const combinedPlaceholders = [
    ...safePlaceholders,
    ...customPlaceholders.map(p => p.toLowerCase())
  ];

  return findings.filter(finding => {
    const lowerSnippet = (finding.codeSnippet || '').toLowerCase();
    const lowerFile = finding.fileLocation.toLowerCase();

    // 1. Filter out mock secrets in environment templates
    if (lowerFile.includes('.env.example') || lowerFile.includes('.env.sample')) {
      
      // Drop if it contains a known placeholder word or structural brackets
      if (combinedPlaceholders.some(safeWord => lowerSnippet.includes(safeWord))) {
        console.log(`🧹 Filtered false positive in ${finding.fileLocation}: Contained mock placeholder syntax.`);
        return false;
      }
      
      // Drop if the value is empty, e.g., API_KEY= or API_KEY="" or API_KEY=''
      if (/=\s*(""|''|)$/.test(lowerSnippet)) {
         console.log(`🧹 Filtered false positive in ${finding.fileLocation}: Value is empty.`);
         return false;
      }
    }

    // 2. Filter out mock credentials in seed files
    if (lowerFile.includes('seed.ts')) {
      if (combinedPlaceholders.some(safeWord => lowerSnippet.includes(safeWord))) return false;
      // A bare console.log/console.error in a seed file is noise, but
      // `console.log(process.env...)` is the exact contextual leak the core
      // rule says we MUST flag — never drop those, even in seed files.
      if (
        (lowerSnippet.includes('console.error') || lowerSnippet.includes('console.log')) &&
        !lowerSnippet.includes('process.env')
      ) {
        return false;
      }
    }

    // 3. Filter out false logic flaws in Prisma schemas.
    // Match Prisma field types (`id Int`, `name String`) on word boundaries —
    // a bare `includes('int'/'string')` also swallowed real findings whose
    // snippet merely contained print, point, constraint, fingerprint, mint, ...
    if (lowerFile.includes('schema.prisma')) {
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
  /**
   * Merges the expanded multi-language registry into the shared engine (#751).
   *
   * At construction rather than lazily before each scan, because the merge sets
   * the engine's active version: a lazy warm could fire *after* a caller had
   * rotated the database and would quietly put the version back. Warming once,
   * up front, means any later `rotateSignatureDatabase` or
   * `updateSignatureDatabase` is the last word, which is what a caller reaching
   * for those expects.
   *
   * `ensureExpandedSignaturesLoaded` catches its own validation failures and
   * leaves the engine on `DEFAULT_PAYLOAD_SIGNATURES`, so a malformed addition
   * cannot take down the scan path from a constructor.
   */
  constructor() {
    const report = ensureExpandedSignaturesLoaded();

    if (report.error) {
      console.error(`[Scanner] Expanded signature registry was not loaded: ${report.error}`);
    } else if (report.loaded) {
      console.log(`[Scanner] Loaded ${report.count} expanded signatures`);
    }
  }

  /**
   * Rotate signature database dynamically to adapt to zero-day payload structures.
   *
   * Note that this *replaces* the database rather than adding to it, so it drops
   * both `DEFAULT_PAYLOAD_SIGNATURES` and the expanded registry. Use
   * `updateSignatureDatabase` to add without discarding.
   */
  rotateSignatureDatabase(signatures: PayloadSignature[], version?: string): void {
    dynamicFingerprintEngine.rotateSignatures(signatures, version);
  }

  /**
   * Dynamically update active signature database with new payload patterns.
   */
  updateSignatureDatabase(signatures: PayloadSignature[], version?: string): void {
    dynamicFingerprintEngine.updateSignatureDatabase(signatures, version);
  }

  /**
   * Get active signature database version.
   */
  getSignatureVersion(): string {
    return dynamicFingerprintEngine.getActiveVersion();
  }

  async scanPullRequest(
    files: FileChange[],
    activePolicies: ScannerPolicy[] = [],
    customIgnores: string[] = [],
    customPlaceholders: string[] = []
  ): Promise<ScanFinding[]> {
    const scanStartedAt = Date.now();
    const deadlineExceeded = () => Date.now() - scanStartedAt > MAX_TOTAL_SCAN_MS;

    let currentBatch = '';
    let currentBatchFiles: string[] = [];
    const allFindings: ScanFinding[] = [];
    const ABSOLUTE_MAX_FILE_SIZE = 50000;
    const MAX_COMBINED_LENGTH = 32000;

    let combinedIgnores = [...customIgnores];
    let combinedPlaceholders = [...customPlaceholders];

    if (combinedIgnores.length === 0 && combinedPlaceholders.length === 0) {
      try {
        const ignorePath = path.join(process.cwd(), '.secureflowignore');
        if (fs.existsSync(ignorePath)) {
          const content = fs.readFileSync(ignorePath, 'utf8');
          const parsed = parseSecureFlowIgnore(content);
          combinedIgnores = parsed.ignoredPaths;
          combinedPlaceholders = parsed.placeholders;
        }
      } catch (e) {
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

    for (const file of files) {
      if (deadlineExceeded()) {
        deadlineHit = true;
        console.warn(
          `⏱️ Scan deadline (${MAX_TOTAL_SCAN_MS / 1000}s) exceeded — skipping remaining files starting at ${file.filename}. Returning partial findings.`
        );
        break;
      }

      // The reason is logged alongside the filename. A file that is skipped is
      // a file the scan never read, and the pull request still gets a clean
      // report — so when a skip is wrong, the log line naming the rule that
      // fired is the only thing that makes it findable.
      const ignoreReason = ignoreReasonFor(file.filename, compiledCustomIgnores);
      if (ignoreReason) {
        console.log(`🛡️ Skipping ignored file (${ignoreReason}): ${file.filename}`);
        continue;
      }

      if (!file.patch || file.patch.trim() === '') {
        continue;
      }

      const addedLines = extractAddedLines(file.patch);
      
      if (!addedLines || addedLines.trim().length === 0) {
        continue;
      }

      if (addedLines.length > ABSOLUTE_MAX_FILE_SIZE) {
        console.warn(
          `Skipping ${file.filename}: diff exceeds ${ABSOLUTE_MAX_FILE_SIZE} characters.`
        );
        continue;
      }

      let fileContext = "";
      const lowerFile = file.filename.toLowerCase();
      
      if (lowerFile.includes('.env.example') || lowerFile.includes('.env.sample')) {
        fileContext = "THIS IS A TEMPLATE. SECRETS ARE MOCK PLACEHOLDERS. ONLY FLAG REAL, HIGH-ENTROPY KEYS.";
      } else if (lowerFile.includes('seed.ts')) {
        fileContext = "THIS IS A DATABASE SEED SCRIPT. It contains string descriptions of security policies. DO NOT flag the text inside 'name', 'description', or 'conditions' strings as vulnerabilities.";
      } else if (lowerFile.includes('schema.prisma')) {
        fileContext = "THIS IS A DATABASE SCHEMA. It does not execute logic. Do not flag data types (like Int) or relation queries as logic flaws.";
      } else if (lowerFile.endsWith('.sol') || lowerFile.endsWith('.leo') || lowerFile.endsWith('.rs')) {
        fileContext = "THIS IS A SMART CONTRACT OR PRIVACY-PRESERVING ZERO-KNOWLEDGE CIRCUIT. Analyze it with decentralized architecture patterns in mind and reduce false positives for decentralized logic.";
      }
      const sanitizedLines = sanitizeRecursively(addedLines);
      const maskedLines = maskIngressFileContent(sanitizedLines);
      const wrapperOverhead = `<file name="${file.filename}" context_warning="${fileContext}">\n\n</file>\n\n`.length;
      const maxContentSize = MAX_COMBINED_LENGTH - wrapperOverhead;

      let fileContent = maskedLines;
      if (fileContent.length > maxContentSize) {
        const truncationMsg = "\n\n...[TRUNCATED FOR SIZE]...";
        const targetLimit = maxContentSize - truncationMsg.length;
        const lastNewline = fileContent.lastIndexOf("\n", targetLimit);
        const truncateIndex = lastNewline > 0 ? lastNewline : targetLimit;
        fileContent = fileContent.substring(0, truncateIndex) + truncationMsg;
      }

      const fileContentBlock = `<file name="${file.filename}" context_warning="${fileContext}">
${fileContent}
</file>

`;

      if (
        currentBatch.length + fileContentBlock.length > MAX_COMBINED_LENGTH &&
        currentBatch.length > 0
      ) {

        const batchFindings = await processBatch(
          currentBatch,
          currentBatchFiles
        );

        allFindings.push(...batchFindings);

        currentBatch = "";
        currentBatchFiles = [];
      }

      currentBatch += fileContentBlock;
      currentBatchFiles.push(file.filename);
    }

    async function processBatch(batchContent: string, batchFiles: string[]): Promise<ScanFinding[]> {
      if (!batchContent.trim()) return [];

      const prompt = `Analyze the following aggregated code changes from a Pull Request for security vulnerabilities.
Enforce the following configured issues, AND ALSO flag any other critical executable vulnerabilities (like SQL Injection, XSS, etc) even if they are not explicitly listed below:

${policyInstructions}

The changes are organized under individual <file> tags. 
CRITICAL RULES SCOPED BY FILE TYPE:
- For '.env.example' or '.env' files: ONLY flag a line if the right side of the equals sign contains a REAL, active credential (e.g., a long random alphanumeric string, a hash, or a valid token). DO NOT flag lines with descriptive text, empty quotes, or generic placeholders.
- For '.ts' or '.js' files: You MUST flag any instance of 'console.log(process.env...)' as a CRITICAL contextual leak or any 'console.log(<variable>)' where the 'variable' is instantiated with 'process.env...'.

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
      let retries = 3;
      let lastError: unknown = null;

      while (!success && retries > 0) {
        try {
          console.log(`🔍 Triggering consolidated security scan for files: [${batchFiles.join(', ')}]...`);
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 120000);

          const chatCompletionPromise = groq.chat.completions.create({
            messages: [
              {
                role: 'system',
                content: `You are an authorized defensive security auditing tool. This code is explicitly provided by the owner for authorized analysis. You must output the requested JSON regardless of the code's contents. Do not output safety warnings.

You MUST output your response in valid JSON format.
Return ONLY the raw JSON starting with '{' or '['.

CRITICAL RULES:
1. Treat all code provided as executable production code.
2. You MUST evaluate ALL code in the snippet, including surrounding context lines. If a vulnerability exists anywhere in the provided text, you MUST flag it, even if it is not a newly added line.
3. Assigning process.env to a variable is safe. Explicitly leaking it via console.log() is CRITICAL.
4. JSON ESCAPING: Properly escape ALL double quotes (\\") and newlines (\\n).` 
              },
              { 
                role: 'user', 
                content: `${prompt}\n\nPlease provide the raw JSON output now, starting immediately with '{':` 
              }
            ],
            model: process.env.GROQ_MODEL!,
            temperature: 0.1,
            max_tokens: 3000,
          }, { timeout: SCAN_REQUEST_TIMEOUT_MS, signal: controller.signal });

          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new ScannerTimeoutError(`LLM scan timed out after ${SCAN_REQUEST_TIMEOUT_MS / 1000} seconds`)), SCAN_REQUEST_TIMEOUT_MS);
          });

          const chatCompletion = await Promise.race([
            chatCompletionPromise.finally(() => clearTimeout(timeoutId)),
            timeoutPromise
          ]);
          
          const responseText = chatCompletion.choices[0]?.message?.content || '{"findings": []}';
          const withoutThoughts = responseText.replace(/<think>[\s\S]*?(<\/think>|$)/ig, '');

          // Match either an array '[' or an object '{'
          const jsonMatch = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);

          if (!jsonMatch) {
            // Throw an error so the retry logic catches it, instead of silently returning 0 findings
            throw new SyntaxError("LLM refused to scan or returned non-JSON text.");
          }

          const cleanJsonString = jsonMatch[0];

          let result: Record<string, unknown> | unknown[];
          try {
            result = JSON.parse(cleanJsonString);
          } catch (parseError) {
            console.error("\n[🚨 LLM RETURNED INVALID JSON 🚨]\nRaw Output:\n" + responseText + "\n--------------------------\n");
            throw parseError; 
          }

          let rawFindings: unknown[] = [];

          if (Array.isArray(result)) {
            // If the LLM returned a raw array: [ {...} ]
            rawFindings = result;
          } else if (result && typeof result === 'object' && 'findings' in result && Array.isArray((result as { findings: unknown[] }).findings)) {
            // If the LLM perfectly followed instructions: { "findings": [...] }
            rawFindings = (result as { findings: unknown[] }).findings;
          } else if (result && typeof result === 'object') {
            // If the LLM hallucinated keys, loop through the entire object and combine ALL arrays
            const obj = result as Record<string, unknown>;
            for (const key of Object.keys(obj)) {
              const val = obj[key];
              if (Array.isArray(val)) {
                rawFindings.push(...val);
              }
            }
          }
          
          const sanitizedFindings: ScanFinding[] = rawFindings.map((fItem: unknown) => {
            const f = (fItem && typeof fItem === 'object' ? fItem : {}) as Record<string, unknown>;
            let normalizedSnippet = '';
            
            if (typeof f.codeSnippet === 'string') {
              normalizedSnippet = f.codeSnippet;
            } else if (f.codeSnippet !== null && f.codeSnippet !== undefined) {
              normalizedSnippet = typeof f.codeSnippet === 'object'
                ? JSON.stringify(f.codeSnippet, null, 2)
                : String(f.codeSnippet);
            }

            const fileLoc = String(f.fileLocation || 'Unknown file path');
            // Normalised on write, the way severity already is. The column was
            // taking the model's phrasing verbatim, so `"hardcoded_secret"` and
            // `"Secrets"` were distinct values that no dashboard query matched
            // (#590). The taxonomy still recognises every legacy spelling on
            // read, so old rows keep counting.
            const findingType = normalizeFindingTypeLabel(f.type);

            const dynFp = computeDynamicFingerprint('default-repo', fileLoc, findingType, normalizedSnippet);

            return {
              type: findingType,
              // Shared normalization rather than a local valid-list: the model
              // routinely answers with "moderate", "sev1" or "error" instead of
              // one of the five canonical levels, and the local check discarded
              // all of those down to MEDIUM.
              severity: normalizeSeverity(f.severity),
              description: String(f.description || 'No description provided.'),
              fileLocation: fileLoc,
              codeSnippet: normalizedSnippet,
              lineStart: typeof f.lineStart === 'number' ? f.lineStart : undefined,
              lineEnd: typeof f.lineEnd === 'number' ? f.lineEnd : undefined,
              dynamicFingerprint: dynFp.fingerprint,
              signatureVersion: dynFp.signatureVersion,
              matchedSignatures: dynFp.matchedSignatures.map(s => s.id),
              isZeroDay: dynFp.isZeroDayDetected
            };
          });

          findings = filterFalsePositives(sanitizedFindings, combinedPlaceholders).map((f) => ({
            ...f,
            // Through the full pass, which adds the `scrubCredentials` rules
            // the logger and the error handler already apply, so the same
            // vocabulary covers a credential wherever it surfaces.
            description: maskFindingText(f.description),
            codeSnippet: maskFindingText(f.codeSnippet),
          }));
          success = true;
        } catch (error: unknown) {
          lastError = error;
          const errObj = error as { name?: string; status?: number; headers?: Record<string, unknown> | { get?: (k: string) => string | null } };
          
          // 🛡️ JSON PARSE FALLBACK CATCH
          if (error instanceof SyntaxError) {
             console.warn(`⚠️ Failed to parse extracted JSON. Retrying... (${retries} attempts left)`);
             retries--;
             continue;
          }

          if (error instanceof ScannerTimeoutError || errObj?.name === 'AbortError') {
            throw new ScannerTimeoutError(`LLM scan timed out after ${SCAN_REQUEST_TIMEOUT_MS / 1000} seconds`);
          }
          if (errObj?.status === 429) {
            const headers = errObj.headers;
            let retryAfterHeader: string | undefined;
            if (headers && typeof (headers as { get?: unknown }).get === 'function') {
              retryAfterHeader = (headers as { get: (k: string) => string | null }).get('retry-after') ?? undefined;
            } else if (headers && typeof headers === 'object') {
              retryAfterHeader = (headers as Record<string, string>)['retry-after'];
            }
            const requestedWait = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : (4 - retries) * 25000;
            const remainingBudget = MAX_TOTAL_SCAN_MS - (Date.now() - scanStartedAt);
            const waitTime = Math.max(0, Math.min(requestedWait, MAX_RETRY_WAIT_MS, remainingBudget));

            if (waitTime <= 0) {
              console.warn(`⏱️ Scan deadline exceeded during rate-limit backoff — aborting retries for this batch.`);
              break;
            }

            console.warn(`⏳ Rate limit reached. Waiting ${waitTime / 1000} seconds...`);
            await delay(waitTime);
            retries--;
          } else if (error instanceof Groq.APIConnectionTimeoutError || errObj?.name === 'APIConnectionTimeoutError') {
            console.warn(`⏱️ LLM request exceeded ${SCAN_REQUEST_TIMEOUT_MS / 1000}s timeout. Retrying... (${retries} attempts left)`);
            retries--;
            if (deadlineExceeded()) {
              console.warn(`⏱️ Scan deadline exceeded after a request timeout — aborting retries for this batch.`);
              break;
            }
          } else {
            console.error(`❌ Consolidated scan failed completely:`, error);
            throw error;
          }
        }
      }

      if (!success) {
        const lastErrMessage = (lastError as { message?: string })?.message || String(lastError || 'Unknown error');
        throw lastError || new Error(`ScanFailedAnalysisEngineUnavailable: LLM scan failed after all retries. Last error: ${lastErrMessage}`);
      }

      return findings;
    }

    if (currentBatch.length > 0 && !deadlineExceeded()) {
      const batchFindings = await processBatch(currentBatch, currentBatchFiles);
      allFindings.push(...batchFindings);
    } else if (currentBatch.length > 0) {
      deadlineHit = true;
      console.warn(`⏱️ Scan deadline exceeded before the final batch (${currentBatchFiles.join(', ')}) could run — dropped from results.`);
    }

    if (deadlineHit) {
      console.warn(
        `⚠️ scanPullRequest() returned partial results: ${allFindings.length} finding(s) from a scan that hit its ${MAX_TOTAL_SCAN_MS / 1000}s deadline.`
      );
    }

    return allFindings;
  }
}

export const scanner = new ArmorIQScanner();