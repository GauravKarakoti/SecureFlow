/**
 * Deterministic Security Checks for GitHub Actions Workflows (#2002)
 *
 * Scans changed workflow files under `.github/workflows/` for common high-risk patterns:
 *  1. pull_request_target combined with checkout of the PR head
 *  2. ${{ github.event.* }} used inside run: steps
 *  3. Actions not pinned to a full 40-character commit SHA
 *  4. permissions: write-all or missing permissions block
 *  5. secrets: inherit on third-party reusable workflows
 *
 * Each finding reports rule ID, line number, and a concrete one-line fix.
 */

import { computeDynamicFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch } from "@/lib/armor/diff";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const RULE_IDS = {
  PULL_REQUEST_TARGET_CHECKOUT: "WORKFLOW_PULL_REQUEST_TARGET_CHECKOUT",
  SCRIPT_INJECTION: "WORKFLOW_SCRIPT_INJECTION",
  UNPINNED_ACTION: "WORKFLOW_UNPINNED_ACTION",
  PERMISSIONS_BROAD_OR_MISSING: "WORKFLOW_PERMISSIONS_BROAD_OR_MISSING",
  SECRETS_INHERIT_THIRD_PARTY: "WORKFLOW_SECRETS_INHERIT_THIRD_PARTY",
} as const;

export interface WorkflowRuleDefinition {
  id: string;
  name: string;
  severity: Severity;
  type: "Vulnerability" | "Misconfig";
  description: string;
  oneLineFix: string;
}

export const WORKFLOW_RULES: Record<string, WorkflowRuleDefinition> = {
  [RULE_IDS.PULL_REQUEST_TARGET_CHECKOUT]: {
    id: RULE_IDS.PULL_REQUEST_TARGET_CHECKOUT,
    name: "PR target trigger with PR head checkout",
    severity: "CRITICAL",
    type: "Vulnerability",
    description:
      "pull_request_target runs with base repository permissions and secrets; checking out the untrusted PR head allows arbitrary code execution with secret access.",
    oneLineFix:
      "Do not checkout untrusted PR head in pull_request_target; switch to pull_request or checkout the base branch without head ref.",
  },
  [RULE_IDS.SCRIPT_INJECTION]: {
    id: RULE_IDS.SCRIPT_INJECTION,
    name: "Script injection via github.event context",
    severity: "HIGH",
    type: "Vulnerability",
    description:
      "Direct expansion of untrusted ${{ github.event.* }} inside run: allows attacker-controlled payload to escape string bounds and execute arbitrary commands.",
    oneLineFix:
      "Pass ${{ github.event... }} to an environment variable in env: and reference the environment variable inside run: instead.",
  },
  [RULE_IDS.UNPINNED_ACTION]: {
    id: RULE_IDS.UNPINNED_ACTION,
    name: "Action not pinned to full commit SHA",
    severity: "MEDIUM",
    type: "Misconfig",
    description:
      "Using mutable tags or branches for third-party actions exposes workflows to supply-chain attacks if the tag is modified or compromised.",
    oneLineFix:
      "Pin action to an immutable 40-character commit SHA: uses: <action>@<40-char-sha> # <version>",
  },
  [RULE_IDS.PERMISSIONS_BROAD_OR_MISSING]: {
    id: RULE_IDS.PERMISSIONS_BROAD_OR_MISSING,
    name: "Excessive or missing workflow permissions",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Workflow specifies broad permissions: write-all or omits top-level permissions, inheriting default repository write access.",
    oneLineFix:
      "Define explicit minimal permissions at the workflow or job level (e.g. permissions: contents: read).",
  },
  [RULE_IDS.SECRETS_INHERIT_THIRD_PARTY]: {
    id: RULE_IDS.SECRETS_INHERIT_THIRD_PARTY,
    name: "Secrets inherit on third-party reusable workflow",
    severity: "HIGH",
    type: "Misconfig",
    description:
      "Passing 'secrets: inherit' to an external reusable workflow transmits all repository secrets to external third-party code.",
    oneLineFix:
      "Explicitly pass only the specific required secrets using secrets: { <name>: ${{ secrets.<NAME> }} } instead of secrets: inherit.",
  },
};

export interface WorkflowRuleFinding {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  type: "Vulnerability" | "Misconfig";
  fileLocation: string;
  lineStart: number;
  lineEnd: number;
  codeSnippet: string;
  description: string;
  oneLineFix: string;
}

export interface WorkflowRuleOptions {
  repositoryId?: string;
}

export interface WorkflowLine {
  number: number;
  content: string;
}

/**
 * Checks whether a given path is a GitHub Actions workflow file.
 * Only files under `.github/workflows/` with .yml or .yaml extension match.
 */
export function isWorkflowFile(filename: string): boolean {
  if (!filename) return false;
  const normalized = filename.replace(/\\/g, "/").replace(/^\.?\//, "");
  return (
    normalized.startsWith(".github/workflows/") &&
    (normalized.toLowerCase().endsWith(".yml") || normalized.toLowerCase().endsWith(".yaml"))
  );
}

/**
 * Extracts line number and content from either a unified diff patch or raw YAML text.
 */
export function extractWorkflowLines(patchOrContent: string): WorkflowLine[] {
  if (!patchOrContent) return [];

  if (patchOrContent.includes("@@")) {
    const parsed = parseUnifiedPatch(patchOrContent);
    return parsed.lines.map((l) => ({ number: l.number, content: l.content }));
  }

  const rawLines = patchOrContent.split(/\r?\n/);
  const isDiff = rawLines.some(
    (l) =>
      l.startsWith("+") || l.startsWith("-") || l.startsWith("diff ") || l.startsWith("index "),
  );

  if (isDiff) {
    const result: WorkflowLine[] = [];
    let lineNum = 1;
    for (const line of rawLines) {
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff ") ||
        line.startsWith("index ")
      ) {
        continue;
      }
      if (line.startsWith("+")) {
        result.push({ number: lineNum, content: line.slice(1) });
        lineNum++;
      } else if (!line.startsWith("-")) {
        result.push({ number: lineNum, content: line });
        lineNum++;
      }
    }
    return result;
  }

  // Pure file content
  return rawLines.map((content, idx) => ({ number: idx + 1, content }));
}

/**
 * Rule 1: Flags pull_request_target combined with checkout of the PR head.
 */
export function checkPullRequestTargetCheckout(
  lines: WorkflowLine[],
  filename: string,
): WorkflowRuleFinding[] {
  // 1. Check if pull_request_target is in the trigger
  let hasPrTargetTrigger = false;
  let inOnSection = false;
  let onIndent = -1;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    if (/^on\s*:\s*.*?\bpull_request_target\b/i.test(trimmed)) {
      hasPrTargetTrigger = true;
      break;
    }

    const onMatch = line.content.match(/^(\s*)on\s*:\s*$/i);
    if (onMatch) {
      inOnSection = true;
      onIndent = onMatch[1].length;
      continue;
    }

    if (inOnSection) {
      const currentIndent = line.content.match(/^(\s*)/)?.[1].length ?? 0;
      if (trimmed.length > 0 && currentIndent <= onIndent) {
        inOnSection = false;
      } else if (/\bpull_request_target\b/i.test(trimmed)) {
        hasPrTargetTrigger = true;
        break;
      }
    }
  }

  if (!hasPrTargetTrigger) return [];

  // 2. Check for checkout of PR head
  const findings: WorkflowRuleFinding[] = [];
  const def = WORKFLOW_RULES[RULE_IDS.PULL_REQUEST_TARGET_CHECKOUT];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    // Check ref or repository pointing to PR head
    const isHeadRef =
      /(?:ref|repository)\s*:\s*.*?(?:\${{\s*)?(?:github\.event\.pull_request\.head|github\.head_ref)/i.test(
        trimmed,
      );

    if (isHeadRef) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: def.description,
        oneLineFix: def.oneLineFix,
      });
    }
  }

  return findings;
}

/**
 * Rule 2: Flags ${{ github.event.* }} inside run: steps.
 */
export function checkScriptInjection(
  lines: WorkflowLine[],
  filename: string,
): WorkflowRuleFinding[] {
  const findings: WorkflowRuleFinding[] = [];
  const def = WORKFLOW_RULES[RULE_IDS.SCRIPT_INJECTION];
  let inRunBlock = false;
  let runIndent = -1;

  const eventExprRegex = /\$\{\{\s*github\.event(?:\.[a-zA-Z0-9_\-\[\]\.\'\"]+)?\s*\}\}/i;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    const singleRunMatch = line.content.match(/^(\s*)(?:-\s+)?run\s*:\s*(.+)$/i);
    if (singleRunMatch) {
      const indent = singleRunMatch[1].length;
      const command = singleRunMatch[2].trim();

      if (/^[|>][-+]?\s*$/.test(command)) {
        inRunBlock = true;
        runIndent = indent;
        continue;
      }

      if (eventExprRegex.test(command)) {
        findings.push({
          ruleId: def.id,
          ruleName: def.name,
          severity: def.severity,
          type: def.type,
          fileLocation: filename,
          lineStart: line.number,
          lineEnd: line.number,
          codeSnippet: trimmed,
          description: def.description,
          oneLineFix: def.oneLineFix,
        });
      }
      continue;
    }

    if (inRunBlock) {
      const indent = line.content.match(/^(\s*)/)?.[1].length ?? 0;
      if (trimmed.length > 0 && indent <= runIndent) {
        inRunBlock = false;
      } else if (trimmed.length > 0) {
        if (eventExprRegex.test(line.content)) {
          findings.push({
            ruleId: def.id,
            ruleName: def.name,
            severity: def.severity,
            type: def.type,
            fileLocation: filename,
            lineStart: line.number,
            lineEnd: line.number,
            codeSnippet: trimmed,
            description: def.description,
            oneLineFix: def.oneLineFix,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Rule 3: Flags actions not pinned to a full 40-character commit SHA.
 */
export function checkUnpinnedActions(
  lines: WorkflowLine[],
  filename: string,
): WorkflowRuleFinding[] {
  const findings: WorkflowRuleFinding[] = [];
  const def = WORKFLOW_RULES[RULE_IDS.UNPINNED_ACTION];

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    const usesMatch = line.content.match(/^\s*(?:-\s+)?uses\s*:\s*([^#\s]+)/i);
    if (!usesMatch) continue;

    const target = usesMatch[1].trim();
    // Skip local actions (./) or docker images (docker://)
    if (target.startsWith("./") || target.startsWith("docker://")) {
      continue;
    }

    const atIndex = target.indexOf("@");
    if (atIndex === -1) {
      // Missing version tag/SHA entirely
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: `Action '${target}' is not pinned to a full 40-character commit SHA.`,
        oneLineFix: `Pin action to a full 40-character commit SHA: uses: ${target}@<commit-sha>`,
      });
      continue;
    }

    const actionName = target.slice(0, atIndex);
    const ref = target.slice(atIndex + 1);

    // If ref is not 40 hex characters, it is unpinned
    if (!/^[0-9a-fA-F]{40}$/.test(ref)) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: `Action '${actionName}' is not pinned to a full 40-character commit SHA (found mutable ref '@${ref}').`,
        oneLineFix: `Pin action to a full 40-character commit SHA: uses: ${actionName}@<commit-sha> # ${ref}`,
      });
    }
  }

  return findings;
}

/**
 * Rule 4: Flags permissions: write-all or missing permissions block.
 */
export function checkWorkflowPermissions(
  lines: WorkflowLine[],
  filename: string,
): WorkflowRuleFinding[] {
  const findings: WorkflowRuleFinding[] = [];
  const def = WORKFLOW_RULES[RULE_IDS.PERMISSIONS_BROAD_OR_MISSING];

  let hasPermissions = false;
  let hasWriteAll = false;

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    if (/^\s*permissions\s*:\s*(?:["']?write-all["']?)\b/i.test(line.content)) {
      hasWriteAll = true;
      hasPermissions = true;
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: "HIGH",
        type: def.type,
        fileLocation: filename,
        lineStart: line.number,
        lineEnd: line.number,
        codeSnippet: trimmed,
        description: "Workflow or job specifies overly broad 'permissions: write-all'.",
        oneLineFix:
          "Specify minimal required permissions (e.g. permissions: contents: read) instead of write-all.",
      });
      continue;
    }

    if (/^\s*permissions\s*:/i.test(line.content)) {
      hasPermissions = true;
    }
  }

  if (!hasPermissions) {
    const firstLineSnippet = lines[0]?.content.trim() || "Workflow missing permissions";
    findings.push({
      ruleId: def.id,
      ruleName: def.name,
      severity: "MEDIUM",
      type: def.type,
      fileLocation: filename,
      lineStart: 1,
      lineEnd: 1,
      codeSnippet: firstLineSnippet,
      description:
        "Workflow does not declare explicit permissions, defaulting to repository-level default permissions.",
      oneLineFix:
        "Add a top-level permissions: block with minimal required scopes (e.g. permissions: contents: read).",
    });
  }

  return findings;
}

/**
 * Rule 5: Flags secrets: inherit on third-party reusable workflows.
 */
export function checkThirdPartySecretsInherit(
  lines: WorkflowLine[],
  filename: string,
): WorkflowRuleFinding[] {
  const findings: WorkflowRuleFinding[] = [];
  const def = WORKFLOW_RULES[RULE_IDS.SECRETS_INHERIT_THIRD_PARTY];

  let inJobs = false;
  let currentJobUses: string | null = null;
  let currentJobSecretsInheritLine: number | null = null;
  let currentJobSecretsInheritSnippet: string | null = null;

  const flushCurrentJob = () => {
    if (
      currentJobUses &&
      !currentJobUses.startsWith("./") &&
      currentJobSecretsInheritLine !== null
    ) {
      findings.push({
        ruleId: def.id,
        ruleName: def.name,
        severity: def.severity,
        type: def.type,
        fileLocation: filename,
        lineStart: currentJobSecretsInheritLine,
        lineEnd: currentJobSecretsInheritLine,
        codeSnippet: currentJobSecretsInheritSnippet || "secrets: inherit",
        description: `Passing 'secrets: inherit' to third-party reusable workflow '${currentJobUses}' exposes all repository secrets.`,
        oneLineFix: def.oneLineFix,
      });
    }
    currentJobUses = null;
    currentJobSecretsInheritLine = null;
    currentJobSecretsInheritSnippet = null;
  };

  for (const line of lines) {
    const trimmed = line.content.trim();
    if (trimmed.startsWith("#")) continue;

    if (/^jobs\s*:\s*$/i.test(trimmed)) {
      flushCurrentJob();
      inJobs = true;
      continue;
    }

    if (!inJobs) continue;

    // Detect job key (indented by 2 to 4 spaces, followed by colon)
    const jobKeyMatch = line.content.match(/^(\s{2,4})([a-zA-Z0-9_\-]+)\s*:\s*$/);
    if (jobKeyMatch) {
      flushCurrentJob();
      continue;
    }

    // Top-level block after jobs
    const indent = line.content.match(/^(\s*)/)?.[1].length ?? 0;
    if (trimmed.length > 0 && indent === 0) {
      flushCurrentJob();
      inJobs = false;
      continue;
    }

    // Job-level uses:
    const usesMatch = line.content.match(/^\s+uses\s*:\s*([^#\s]+)/i);
    if (usesMatch) {
      currentJobUses = usesMatch[1].trim();
    }

    // Job-level secrets: inherit
    if (/^\s+secrets\s*:\s*(?:["']?inherit["']?)\b/i.test(line.content)) {
      currentJobSecretsInheritLine = line.number;
      currentJobSecretsInheritSnippet = trimmed;
    }
  }

  flushCurrentJob();
  return findings;
}

/**
 * Scans a single workflow file and returns normalized ScanFinding items.
 */
export function scanWorkflowFile(
  filename: string,
  patchOrContent: string,
  options: WorkflowRuleOptions = {},
): ScanFinding[] {
  if (!isWorkflowFile(filename)) {
    return [];
  }

  const lines = extractWorkflowLines(patchOrContent);
  if (lines.length === 0) {
    return [];
  }

  const rawFindings: WorkflowRuleFinding[] = [
    ...checkPullRequestTargetCheckout(lines, filename),
    ...checkScriptInjection(lines, filename),
    ...checkUnpinnedActions(lines, filename),
    ...checkWorkflowPermissions(lines, filename),
    ...checkThirdPartySecretsInherit(lines, filename),
  ];

  const repositoryId = options.repositoryId || "default-repo";

  return rawFindings.map((finding) => {
    const dynFp = computeDynamicFingerprint(
      repositoryId,
      filename,
      finding.type,
      finding.codeSnippet,
    );
    const langInfo = detectFileLanguage(filename, finding.codeSnippet);

    return {
      type: finding.type,
      severity: finding.severity,
      confidence: "HIGH",
      confidenceReason: `Deterministic workflow security rule: ${finding.ruleId}`,
      description: `[${finding.ruleId}] ${finding.description} Fix: ${finding.oneLineFix}`,
      fileLocation: filename,
      codeSnippet: finding.codeSnippet,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      dynamicFingerprint: dynFp.fingerprint,
      signatureVersion: "1.0.0",
      matchedSignatures: [finding.ruleId, "workflow-rules-deterministic"],
      isZeroDay: false,
      language: langInfo.language,
      ...(langInfo.framework ? { framework: langInfo.framework } : {}),
      remediation: finding.oneLineFix,
    };
  });
}

/**
 * Runs workflow security rules across a set of changed files.
 * Ignores any files outside of `.github/workflows/`.
 */
export function runWorkflowSecurityRules(
  files: FileChange[],
  options: WorkflowRuleOptions = {},
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (const file of files) {
    if (!isWorkflowFile(file.filename)) continue;
    if (!file.patch || !file.patch.trim()) continue;

    const fileFindings = scanWorkflowFile(file.filename, file.patch, options);
    findings.push(...fileFindings);
  }

  return findings;
}
