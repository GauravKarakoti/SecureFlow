import Groq from 'groq-sdk';
import prisma from '../prisma';

export type ScanFinding = {
  type: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  description: string;
  fileLocation: string;
  codeSnippet: string;
};

export interface FileChange {
  filename: string;
  patch: string;
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Non-executable text, assets, metadata or dependency configurations that shouldn't be audited
const IGNORED_EXTENSIONS = [
  'lock.json', '.lock', 'lock.yaml', '.csv',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz',
  '.md', 'tsconfig.json'
];

const IGNORED_PATHS = [
  'dist/', 'build/', '.next/', 'node_modules/', 'prisma/migrations/'
];

function shouldIgnore(filename: string): boolean {
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

  return false;
}

/**
 * Extracts only newly added or modified lines from a unified diff patch.
 * This filters out context lines, metadata headers, and deleted lines.
 */
function extractAddedLines(patch: string): string {
  if (!patch) return '';
  return patch
    .split('\n')
    // Keep lines starting with '+' but exclude the '+++' file target header line
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    // Strip the leading '+' prefix so it passes valid syntax to the LLM
    .map(line => line.slice(1))
    .join('\n');
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
  async scanPullRequest(files: FileChange[], activePolicies: any[] = []): Promise<ScanFinding[]> {
    let currentBatch = '';
    let currentBatchFiles: string[] = [];
    const allFindings: ScanFinding[] = [];
    const MAX_COMBINED_LENGTH = 8000; 

    let policyInstructions = `CORE RULES:\n1. Hardcoded secrets (actual active production string values).\n2. Contextual leaks (explicitly logging secret variables to the console or exposing them to clients).`;

    if (activePolicies && activePolicies.length > 0) {
      policyInstructions += `\n\nCUSTOM POLICIES TO ENFORCE:\n`;
      activePolicies.forEach((policy, index) => {
        policyInstructions += `- Rule ${index + 1}: ${policy.description}\n`;
      });
    } else {
      policyInstructions += `\n\nCRITICAL: DO NOT focus on or flag general vulnerabilities like SQL injection, XSS, or logic flaws. ONLY FOCUS ON THE DEFAULT SECRET-RELATED ISSUES ABOVE.`;
    }

    for (const file of files) {
      if (shouldIgnore(file.filename)) {
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

      const fileContentChunk = `<file name="${file.filename}" context_warning="${fileContext}">\n${addedLines}\n</file>\n\n`;

      if (currentBatch.length + fileContentChunk.length > MAX_COMBINED_LENGTH && currentBatch.length > 0) {
        const batchFindings = await processBatch(currentBatch, currentBatchFiles);
        allFindings.push(...batchFindings);
        
        currentBatch = '';
        currentBatchFiles = [];
      }

      currentBatch += fileContentChunk;
      currentBatchFiles.push(file.filename);
    }

    if (currentBatch.length > 0) {
      const batchFindings = await processBatch(currentBatch, currentBatchFiles);
      allFindings.push(...batchFindings);
    }

    return allFindings;

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
      "codeSnippet": "The specific problematic line(s)"
    }
  ]
}`;

      let findings: ScanFinding[] = [];
      let success = false;
      let retries = 3;

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
5. You MUST return a root JSON object with a "findings" key array. The "reasoning" key must come first in each object.` 
              },
              { role: 'user', content: prompt }
            ],
            model: 'llama-3.1-8b-instant',
            response_format: { type: 'json_object' },
          });

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
              codeSnippet: normalizedSnippet
            };
          });

          findings = filterFalsePositives(sanitizedFindings);
          success = true;
        } catch (error: any) {
          if (error.status === 429) {
            const retryAfterHeader = error.headers?.get?.('retry-after') || error.headers?.['retry-after'];
            const waitTime = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : (4 - retries) * 25000;
            
            console.warn(`⏳ Rate limit reached. Waiting ${waitTime / 1000} seconds...`);
            await delay(waitTime);
            retries--;
          } else if (error.status === 400 && error.error?.code === 'json_validate_failed') {
            console.warn(`⚠️ LLM generated invalid JSON. Retrying... (${retries} attempts left)`);
            retries--;
          } else {
            console.error(`❌ Consolidated scan failed completely:`, error);
            break;
          }
        }
      }

      return findings;
    }
  }
}

// async function vulnerable_test(userInput: string) {
//   await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE name = ${userInput}`);
//   console.log(process.env.GROQ_API_KEY);
// }

export const scanner = new ArmorIQScanner();