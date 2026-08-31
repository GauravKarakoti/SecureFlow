import { z } from 'zod';
import { ScanFinding, FileChange } from './scanner';

/**
 * A custom policy engine injected via `secureflow.config.json`.
 *
 * Teams define rules as a list of pattern-based checks. Each rule is evaluated
 * against every added line in every changed file. Matches produce findings that
 * are merged into the LLM findings before the policy decision is made.
 */
export interface CustomPolicyRule {
  /** Human-readable name shown in the PR comment and dashboard. */
  id: string;
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  /** Regex pattern matched against each added line. */
  pattern: string;
  /** Optional glob patterns — rule only fires on matching file paths. */
  filePatterns?: string[];
}

export interface SecureFlowConfig {
  /** Custom policy rules injected into the scanning pipeline. */
  policies?: CustomPolicyRule[];
  /** Additional paths to ignore (merged with .secureflowignore). */
  ignoredPaths?: string[];
  /** Additional placeholder strings for false-positive filtering. */
  placeholders?: string[];
}

const customPolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  pattern: z.string().min(1),
  filePatterns: z.array(z.string()).optional(),
});

const secureFlowConfigSchema = z.object({
  policies: z.array(customPolicyRuleSchema).optional(),
  ignoredPaths: z.array(z.string()).optional(),
  placeholders: z.array(z.string()).optional(),
});

export function parseSecureFlowConfig(raw: string): SecureFlowConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('secureflow.config.json is not valid JSON');
  }
  const result = secureFlowConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`secureflow.config.json validation failed: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Run all custom policy rules against the changed files and return findings.
 *
 * Only added lines (starting with `+`) are evaluated — same scope as the LLM.
 * Each rule's `pattern` is compiled once and matched per line; a match on a
 * file that satisfies `filePatterns` (or any file when omitted) produces a
 * finding. Regex compilation errors are logged and the rule is skipped rather
 * than crashing the scan.
 */
export function runCustomPolicies(
  files: FileChange[],
  rules: CustomPolicyRule[]
): ScanFinding[] {
  if (!rules.length) return [];

  const findings: ScanFinding[] = [];

  for (const rule of rules) {
    let ruleRegex: RegExp;
    try {
      ruleRegex = new RegExp(rule.pattern);
    } catch {
      console.warn(`[config-loader] Skipping rule "${rule.id}": invalid regex pattern "${rule.pattern}"`);
      continue;
    }

    const fileRegexes = rule.filePatterns?.map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    }).filter(Boolean) as RegExp[] | undefined;

    for (const file of files) {
      if (fileRegexes?.length && !fileRegexes.some((r) => r.test(file.filename))) {
        continue;
      }

      if (!file.patch) continue;

      const lines = file.patch.split('\n');
      let newLineNumber = 0;

      for (const line of lines) {
        // Track new-file line numbers from hunk headers
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (hunkMatch) {
          newLineNumber = parseInt(hunkMatch[1], 10) - 1;
          continue;
        }
        if (line.startsWith('-')) continue;
        if (!line.startsWith('\\')) newLineNumber++;

        const content = line.startsWith('+') ? line.slice(1) : line;
        if (ruleRegex.test(content)) {
          findings.push({
            type: 'Vulnerability',
            severity: rule.severity,
            description: `[Custom Policy: ${rule.id}] ${rule.description}`,
            fileLocation: file.filename,
            codeSnippet: content.trim(),
            lineStart: newLineNumber,
            lineEnd: newLineNumber,
          });
        }
      }
    }
  }

  return findings;
}
