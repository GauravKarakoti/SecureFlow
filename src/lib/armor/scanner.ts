import Groq from 'groq-sdk';
import prisma from '../prisma';

export type ScanFinding = {
  type: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  description: string;
  fileLocation: string;
  codeSnippet: string;
  lineStart?: number;
  lineEnd?: number;
};

export interface FileChange {
  filename: string;
  patch: string;
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'dummy-key-for-build',
});

// --- Timeout / deadline guards -------------------------------------------------------------
// A single malformed or maliciously-crafted diff (e.g. one engineered to make the LLM hang,
// or a PR large enough to spawn many batches) must never be able to hang the scan indefinitely
// or exhaust memory. These bound worst-case behavior explicitly rather than relying on the
// HTTP client's own defaults (Groq's SDK default is 1 minute per request, with no cap at all
// on the number of batches a large PR can produce).
const SCAN_REQUEST_TIMEOUT_MS = 20_000; // hard cap per individual LLM call
const MAX_TOTAL_SCAN_MS = 120_000; // hard cap across the whole scanPullRequest() call
const MAX_RETRY_WAIT_MS = 15_000; // cap on any single rate-limit backoff wait

// --- Recursive sanitization guards ---------------------------------------------------------
// A single pass of `<`/`>` escaping can be defeated by nesting or stacking encodings (e.g.
// HTML-entity-encoded entities, unicode escape sequences, zero-width characters used to split
// up flagged keywords). sanitizeRecursively() normalizes until stable or these caps are hit,
// so the normalization loop itself can't become a new hang/memory vector.
const MAX_SANITIZE_ITERATIONS = 5;
const MAX_SANITIZED_LENGTH = 100_000;

// Non-executable text, assets, metadata or dependency configurations that shouldn't be audited
const IGNORED_EXTENSIONS = [
  'lock.json', '.lock', 'lock.yaml', '.csv',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz',
  '.md', 'tsconfig.json'
];

const IGNORED_PATHS = [
  'dist/', 'build/', '.next/', 'node_modules/', 'prisma/migrations/'
];

function compileIgnorePatterns(patterns: string[]): RegExp[] {
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

function shouldIgnore(filename: string, customIgnores: RegExp[] = []): boolean {
  const lower = filename.toLowerCase();
  
  // 1. Path-level exclusions
  if (IGNORED_PATHS.some(path => lower.includes(path))) {
    return true;
  }
  
  // 2. Extension-level exclusions
  if (IGNORED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    return true;
  }

  // 3. Ignore configuration wrappers (Note: .env.example is intentionally NOT ignored here)
  const ignorePatterns = ['package.json', 'components.json', 'prisma.config.ts', '.gitignore'];
  if (ignorePatterns.some(pattern => lower.includes(pattern))) {
    return true;
  }

  // 4. Custom ignores matching
  const normalizedPath = filename.replace(/\\/g, '/');
  if (customIgnores.some(regex => regex.test(normalizedPath))) {
    return true;
  }

  return false;
}

/**
 * Extracts only newly added or modified lines from a unified diff patch.
 * This filters out context lines, metadata headers, and deleted lines.
 */
export function extractAddedLines(patch: string): string {
  if (!patch) return '';
  
  const processedLines: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue; 
    } 
    // Tag newly added code AND strip the '+' sign
    else if (line.startsWith('+')) {
      processedLines.push(`[ADDED] ${line.substring(1)}`);
    } 
    // Preserve surrounding context AND strip the leading space
    else if (line.startsWith(' ')) {
      processedLines.push(line.substring(1));
    }
  }
  return processedLines.join('\n');
}

/**
 * Split oversized file contents into newline-aware chunks.
 */
function splitIntoChunks(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChunkSize, text.length);
    // Prefer splitting at the last newline instead of the middle of a line
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start) {
        end = lastNewline;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function filterFalsePositives(findings: ScanFinding[]): ScanFinding[] {
  const safePlaceholders = [
    'your_', 'actual_', 'secret_here', 'placeholder', 
    'user:password', 'auth_secret', 'localhost', '127.0.0.1',
    'example', 'dummy', 'replace_me', 'changeme',
    '<', '>', '{', '}', '[', ']'
  ];

  return findings.filter(finding => {
    const lowerSnippet = (finding.codeSnippet || '').toLowerCase();
    const lowerFile = finding.fileLocation.toLowerCase();

    // 1. Filter out mock secrets in environment templates
    if (lowerFile.includes('.env.example') || lowerFile.includes('.env.sample')) {
      
      // Drop if it contains a known placeholder word or structural brackets
      if (safePlaceholders.some(safeWord => lowerSnippet.includes(safeWord))) {
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
      if (safePlaceholders.some(safeWord => lowerSnippet.includes(safeWord))) return false;
      if (lowerSnippet.includes('console.error') || lowerSnippet.includes('console.log')) return false;
    }

    // 3. Filter out false logic flaws in Prisma schemas
    if (lowerFile.includes('schema.prisma')) {
      if (lowerSnippet.includes('int') || lowerSnippet.includes('string')) return false;
    }

    return true;
  });
}

export class ArmorIQScanner {
  async scanPullRequest(files: FileChange[], activePolicies: any[] = [], customIgnores: string[] = []): Promise<ScanFinding[]> {
    const scanStartedAt = Date.now();
    const deadlineExceeded = () => Date.now() - scanStartedAt > MAX_TOTAL_SCAN_MS;

    let currentBatch = '';
    let currentBatchFiles: string[] = [];
    const allFindings: ScanFinding[] = [];
    const ABSOLUTE_MAX_FILE_SIZE = 50000;
    const MAX_COMBINED_LENGTH = 8000; 

    const compiledCustomIgnores = compileIgnorePatterns(customIgnores);

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

      if (shouldIgnore(file.filename, compiledCustomIgnores)) {
        console.log(`🛡️ Skipping ignored file: ${file.filename}`);
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
      const wrapperOverhead =
        `<file name="${file.filename}" context_warning="${fileContext}"></file>\n\n`.length;

      const maxContentSize = MAX_COMBINED_LENGTH - wrapperOverhead;

      const sanitizedLines = sanitizeRecursively(addedLines);

      const chunks =
        sanitizedLines.length > maxContentSize
          ? splitIntoChunks(sanitizedLines, maxContentSize)
          : [sanitizedLines];

      for (let i = 0; i < chunks.length; i++) {

        const partSuffix =
          chunks.length > 1
            ? ` (part ${i + 1}/${chunks.length})`
            : "";

        const fileContentChunk =
`<file name="${file.filename}${partSuffix}" context_warning="${fileContext}">
${chunks[i]}
</file>

`;

        if (
          currentBatch.length + fileContentChunk.length > MAX_COMBINED_LENGTH &&
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

        currentBatch += fileContentChunk;

        currentBatchFiles.push(
          `${file.filename}${partSuffix}`
        );
      }
    }

    async function processBatch(batchContent: string, batchFiles: string[]): Promise<ScanFinding[]> {
      if (!batchContent.trim()) return [];

      const prompt = `Analyze the following aggregated code changes from a Pull Request for security vulnerabilities.
Look strictly for the following configured issues:

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
      let lastError: any = null;

      while (!success && retries > 0) {
        try {
          console.log(`🔍 Triggering consolidated security scan for files: [${batchFiles.join(', ')}]...`);
          
          const chatCompletion = await groq.chat.completions.create({
            messages: [
              {
                role: 'system',
                content: `You are an elite application security auditor. Output raw JSON only.

CRITICAL RULES:
1. ONLY flag actual, executable vulnerabilities.
2. Assigning process.env to a variable is safe. HOWEVER, explicitly leaking process.env via console.log() or returning it to the client is a CRITICAL VULNERABILITY. You MUST flag any instance of console.log(process.env...).
3. SELF-REFERENTIAL TRAP: You are scanning a security tool. Do NOT flag string literals or text descriptions of security policies (e.g., text inside seed files) as vulnerabilities.
4. JSON ESCAPING (CRITICAL): You MUST properly escape ALL double quotes (\\") and newlines (\\n) inside the "codeSnippet" and "description" fields. NEVER use unescaped double quotes, and NEVER try to use JavaScript string concatenation (+) inside the JSON structure.
5. You MUST return a root JSON object with a "findings" key array. The "reasoning" key must come first in each object.
6. The provided code contains both new changes and surrounding context. Focus your security analysis EXCLUSIVELY on lines starting with the [ADDED] tag. All other lines are provided strictly as read-only structural context to help you understand the scope, and should not be flagged for vulnerabilities.` 
              },
              { role: 'user', content: prompt }
            ],
            model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
            response_format: { type: 'json_object' },
          }, { timeout: SCAN_REQUEST_TIMEOUT_MS });

          const responseText = chatCompletion.choices[0]?.message?.content || '{"findings": []}';
          const result = JSON.parse(responseText);
          
          const rawFindings = result.findings || [];
          
          const sanitizedFindings: ScanFinding[] = rawFindings.map((f: any) => {
            let normalizedSnippet = '';
            
            if (typeof f.codeSnippet === 'string') {
              normalizedSnippet = f.codeSnippet;
            } else if (f.codeSnippet !== null && f.codeSnippet !== undefined) {
              normalizedSnippet = typeof f.codeSnippet === 'object'
                ? JSON.stringify(f.codeSnippet, null, 2)
                : String(f.codeSnippet);
            }

            const upperSeverity = String(f.severity || 'MEDIUM').toUpperCase();
            const validSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];

            return {
              type: String(f.type || 'Vulnerability'),
              severity: validSeverities.includes(upperSeverity) ? (upperSeverity as any) : 'MEDIUM',
              description: String(f.description || 'No description provided.'),
              fileLocation: String(f.fileLocation || 'Unknown file path'),
              codeSnippet: normalizedSnippet,
              lineStart: typeof f.lineStart === 'number' ? f.lineStart : undefined,
              lineEnd: typeof f.lineEnd === 'number' ? f.lineEnd : undefined
            };
          });

          findings = filterFalsePositives(sanitizedFindings);
          success = true;
        } catch (error: any) {
          lastError = error;
          if (error.status === 429) {
            const retryAfterHeader = error.headers?.get?.('retry-after') || error.headers?.['retry-after'];
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
          } else if (error.status === 400 && error.error?.code === 'json_validate_failed') {
            console.warn(`⚠️ LLM generated invalid JSON. Retrying... (${retries} attempts left)`);
            retries--;
          } else if (error instanceof Groq.APIConnectionTimeoutError || error?.name === 'APIConnectionTimeoutError') {
            console.warn(`⏱️ LLM request exceeded ${SCAN_REQUEST_TIMEOUT_MS / 1000}s timeout. Retrying... (${retries} attempts left)`);
            retries--;
            if (deadlineExceeded()) {
              console.warn(`⏱️ Scan deadline exceeded after a request timeout — aborting retries for this batch.`);
              break;
            }
          } else {
            console.error(`❌ Consolidated scan failed completely:`, error);
            break;
          }
        }
      }

      if (!success) {
        throw new Error(`ScanFailedAnalysisEngineUnavailable: LLM scan failed after all retries. Last error: ${lastError?.message || lastError || 'Unknown error'}`);
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