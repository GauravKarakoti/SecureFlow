import { createHmac, createHash } from "node:crypto";
import {
  AUTO_REMEDIATION_ARMORIQ_SCOPE,
  isAllowedAutoRemediationPath,
} from "./auto-remediation";

export type AgentActionType =
  | "shell.exec"
  | "fs.write"
  | "fs.read"
  | "github.pull_request.create"
  | "github.pull_request.merge"
  | "github.push"
  | string;

export interface AgentCommand {
  type: AgentActionType;
  command?: string;
  path?: string;
  args?: Record<string, unknown>;
  content?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

export type VerdictDecision = "ALLOW" | "DENY";

export interface VerdictProof {
  verified: boolean;
  verdict: VerdictDecision;
  intercepted: boolean;
  executionPrevented: boolean;
  command: AgentCommand;
  rule: string;
  reason: string;
  timestamp: number;
  proofHash: string;
  signature: string;
}

export interface InterceptVerdict {
  action: VerdictDecision;
  decision: VerdictDecision;
  allowed: boolean;
  intercepted: boolean;
  reason: string;
  rule: string;
  command: AgentCommand;
  timestamp: number;
  metadata?: Record<string, unknown>;
  prove(): VerdictProof;
}

export interface AgentExecutionResult {
  executed: boolean;
  verdict: InterceptVerdict;
  output?: unknown;
  error?: string;
}

const DEFAULT_SIGNING_KEY =
  process.env.ARMORIQ_PROOF_SIGNING_KEY || "armoriq-boundary-provenance-key-v1";

/**
 * Computes a deterministic SHA-256 hash for a verdict record.
 */
function computeVerdictHash(
  command: AgentCommand,
  decision: VerdictDecision,
  rule: string,
  timestamp: number,
): string {
  const payload = JSON.stringify({
    cmdType: command.type,
    cmdStr: command.command ?? null,
    cmdPath: command.path ?? null,
    cmdPrompt: command.prompt ?? null,
    decision,
    rule,
    timestamp,
  });

  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Signs a proof hash using HMAC-SHA256 to guarantee provenance and authenticity.
 */
function signProofHash(proofHash: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(proofHash).digest("hex");
}

/**
 * ArmorIQ Boundary Interceptor for agent execution control.
 * Intercepts, evaluates, and cryptographically proves boundary enforcements
 * before any agent action can touch the system, filesystem, or repositories.
 */
export class ArmorIQBoundaryInterceptor {
  private signingKey: string;

  constructor(signingKey: string = DEFAULT_SIGNING_KEY) {
    this.signingKey = signingKey;
  }

  /**
   * Evaluates an agent action against Zero-Trust ArmorIQ boundary rules.
   * Intercepts and issues a DENY verdict before execution if out-of-scope or malicious.
   */
  intercept(command: AgentCommand): InterceptVerdict {
    const timestamp = Date.now();
    const violation = this.detectBoundaryViolation(command);

    if (violation) {
      const decision: VerdictDecision = "DENY";
      const rule = violation.rule;
      const reason = violation.reason;
      const proofHash = computeVerdictHash(command, decision, rule, timestamp);
      const signature = signProofHash(proofHash, this.signingKey);

      return {
        action: "DENY",
        decision: "DENY",
        allowed: false,
        intercepted: true,
        reason,
        rule,
        command,
        timestamp,
        metadata: {
          category: violation.category,
          scopePolicy: AUTO_REMEDIATION_ARMORIQ_SCOPE,
        },
        prove: (): VerdictProof => {
          // Verify that the proof matches the issued verdict and prevented execution
          const currentHash = computeVerdictHash(command, decision, rule, timestamp);
          const expectedSig = signProofHash(currentHash, this.signingKey);
          const isAuthentic = currentHash === proofHash && expectedSig === signature;

          return {
            verified: isAuthentic,
            verdict: "DENY",
            intercepted: true,
            executionPrevented: true,
            command,
            rule,
            reason,
            timestamp,
            proofHash,
            signature,
          };
        },
      };
    }

    // Permitted in-scope action
    const decision: VerdictDecision = "ALLOW";
    const rule = "allow:in_scope";
    const reason = "Action complies with ArmorIQ auto-remediation boundary policy";
    const proofHash = computeVerdictHash(command, decision, rule, timestamp);
    const signature = signProofHash(proofHash, this.signingKey);

    return {
      action: "ALLOW",
      decision: "ALLOW",
      allowed: true,
      intercepted: false,
      reason,
      rule,
      command,
      timestamp,
      prove: (): VerdictProof => ({
        verified: true,
        verdict: "ALLOW",
        intercepted: false,
        executionPrevented: false,
        command,
        rule,
        reason,
        timestamp,
        proofHash,
        signature,
      }),
    };
  }

  /**
   * Cryptographically verifies an issued VerdictProof.
   */
  static verifyProof(proof: VerdictProof, signingKey: string = DEFAULT_SIGNING_KEY): boolean {
    if (!proof || typeof proof !== "object") return false;
    if (proof.verdict === "DENY" && !proof.executionPrevented) return false;

    const recalculatedHash = computeVerdictHash(
      proof.command,
      proof.verdict,
      proof.rule,
      proof.timestamp,
    );

    if (recalculatedHash !== proof.proofHash) return false;

    const recalculatedSig = signProofHash(recalculatedHash, signingKey);
    return recalculatedSig === proof.signature;
  }

  /**
   * Detects boundary violations based on action type, command strings, and file paths.
   */
  private detectBoundaryViolation(command: AgentCommand): {
    rule: string;
    reason: string;
    category: string;
  } | null {
    const rawType = (command.type || "").toLowerCase();
    const rawCommand = (command.command || "").toLowerCase();
    const rawPath = (command.path || "").toLowerCase();
    const prompt = (command.prompt || "").toLowerCase();

    // 1. Shell execution & arbitrary system command violation
    if (
      rawType === "shell.exec" ||
      rawType.startsWith("shell.") ||
      rawType === "exec" ||
      rawType === "spawn" ||
      /shell\.exec\b/.test(prompt) ||
      /\b(rm\s+-rf|rmdir|mkfs|dd\s+if=|chmod\s+777|curl\s+http|wget\s+http|nc\s+-e|bash\s+-c)\b/i.test(
        rawCommand || prompt,
      )
    ) {
      return {
        rule: "deny:shell_execution",
        reason: "Shell and arbitrary system command execution is prohibited by ArmorIQ boundary policy",
        category: "SYSTEM_COMMAND_EXECUTION",
      };
    }

    // 2. Tampering with CI/CD workflows (.github/workflows/)
    if (
      rawPath.includes(".github/workflows") ||
      /\.github\/workflows\b/i.test(prompt) ||
      /\.github\/workflows\b/i.test(rawCommand)
    ) {
      return {
        rule: "deny:workflow_tampering",
        reason: "Modifying or reading CI/CD workflows (.github/workflows/) is prohibited by ArmorIQ boundary policy",
        category: "WORKFLOW_TAMPERING",
      };
    }

    // 3. Sensitive credentials, SSH keys, cloud tokens
    if (
      rawPath.includes(".ssh") ||
      rawPath.includes(".aws") ||
      rawPath.includes(".env") ||
      rawPath.includes("id_rsa") ||
      rawPath.includes("id_ed25519") ||
      rawPath.includes("known_hosts") ||
      rawPath.includes("/etc/passwd") ||
      rawPath.includes("/etc/shadow") ||
      /~?\/?\.ssh\b/i.test(prompt) ||
      /~?\/?\.aws\b/i.test(prompt) ||
      /\.env\b/i.test(prompt) ||
      /\/etc\/passwd\b/i.test(prompt)
    ) {
      return {
        rule: "deny:sensitive_credentials",
        reason: "Accessing sensitive credential stores (~/.ssh, ~/.aws, .env, /etc/passwd) is blocked by ArmorIQ boundary policy",
        category: "CREDENTIAL_EXFILTRATION",
      };
    }

    // 4. Unauthorized git operations (direct push, merge)
    if (
      rawType === "github.push" ||
      rawType === "github.pull_request.merge" ||
      AUTO_REMEDIATION_ARMORIQ_SCOPE.deny.includes(rawType as any) ||
      /\bgithub\.push\b/i.test(prompt) ||
      /\bgithub\.pull_request\.merge\b/i.test(prompt)
    ) {
      return {
        rule: "deny:unauthorized_git_mutation",
        reason: `Git operation '${rawType}' is explicitly denied by ArmorIQ auto-remediation scope`,
        category: "UNAUTHORIZED_GIT_MUTATION",
      };
    }

    // 5. Filesystem write outside allowed src/** scope
    if (rawType === "fs.write") {
      if (!command.path || !isAllowedAutoRemediationPath(command.path)) {
        return {
          rule: "deny:unscoped_filesystem_write",
          reason: `Target path '${command.path ?? "unknown"}' is outside allowed auto-remediation scope (src/**)`,
          category: "OUT_OF_SCOPE_FILESYSTEM_ACCESS",
        };
      }
    }

    // 6. Filesystem read outside allowed repository boundaries (path traversal or system paths)
    if (rawType === "fs.read") {
      if (
        command.path &&
        (command.path.includes("..") ||
          command.path.startsWith("/") ||
          command.path.startsWith("~") ||
          command.path.includes("\\"))
      ) {
        return {
          rule: "deny:unscoped_filesystem_read",
          reason: `Filesystem read for path '${command.path}' violates path boundary constraints`,
          category: "OUT_OF_SCOPE_FILESYSTEM_ACCESS",
        };
      }
    }

    return null;
  }
}

/**
 * SecureFlow Agent wrapper that integrates with ArmorIQBoundaryInterceptor.
 * Demonstrates the full lifecycle: Prompt -> Intercept -> Intercept Verdict -> Proof.
 */
export class SecureFlowAgent {
  private interceptor: ArmorIQBoundaryInterceptor;

  constructor(interceptor: ArmorIQBoundaryInterceptor = new ArmorIQBoundaryInterceptor()) {
    this.interceptor = interceptor;
  }

  /**
   * Executes a command through the ArmorIQ boundary filter.
   * If intercepted, execution is halted immediately and a DENY verdict is returned.
   */
  async execute(command: AgentCommand): Promise<AgentExecutionResult> {
    const verdict = this.interceptor.intercept(command);

    if (verdict.action === "DENY") {
      return {
        executed: false,
        verdict,
        error: `Action blocked by ArmorIQ boundary: ${verdict.reason}`,
      };
    }

    // Simulated benign execution for approved in-scope operations
    return {
      executed: true,
      verdict,
      output: { status: "success", detail: "Action completed in-scope" },
    };
  }

  /**
   * Processes a natural language prompt, maps it to a proposed agent command,
   * and runs it through the ArmorIQ interceptor.
   */
  async promptAndExecute(promptText: string): Promise<AgentExecutionResult> {
    const command = this.parsePromptToCommand(promptText);
    return this.execute(command);
  }

  /**
   * Extracts intent and parameters from an adversarial or regular prompt.
   */
  private parsePromptToCommand(prompt: string): AgentCommand {
    const lower = prompt.toLowerCase();

    if (/shell\.exec|rm\s+-rf|system\.exec|bash|sh\s+-c/i.test(lower)) {
      const matchCmd = prompt.match(/(?:shell\.exec|exec|run)\s+([^\n\r;]+)/i);
      return {
        type: "shell.exec",
        command: matchCmd ? matchCmd[1].trim() : "rm -rf /",
        prompt: promptTextSanitize(prompt),
      };
    }

    if (/\.github\/workflows/i.test(lower)) {
      const pathMatch = prompt.match(/(\.github\/workflows\/[a-zA-Z0-9_\-\.]+)/i);
      return {
        type: "fs.write",
        path: pathMatch ? pathMatch[1] : ".github/workflows/ci.yml",
        content: "# modified workflow",
        prompt: promptTextSanitize(prompt),
      };
    }

    if (/~\/\.ssh|\.ssh\/keys|\.ssh\/id_rsa|\.aws|\.env|\/etc\/passwd/i.test(lower)) {
      const pathMatch = prompt.match(/(~\/\.ssh\/[a-zA-Z0-9_\-\.]+|\.ssh\/[a-zA-Z0-9_\-\.]+|\/etc\/passwd|\.env)/i);
      return {
        type: "fs.read",
        path: pathMatch ? pathMatch[1] : "~/.ssh/keys",
        prompt: promptTextSanitize(prompt),
      };
    }

    if (/github\.push|push\s+to\s+main|direct\s+push/i.test(lower)) {
      return {
        type: "github.push",
        prompt: promptTextSanitize(prompt),
      };
    }

    if (/pull_request\.merge|merge\s+pr|auto-merge/i.test(lower)) {
      return {
        type: "github.pull_request.merge",
        prompt: promptTextSanitize(prompt),
      };
    }

    // Default to in-scope file modification if mentioning src/
    if (/src\//i.test(lower)) {
      const pathMatch = prompt.match(/(src\/[a-zA-Z0-9_\-\/\.]+)/i);
      return {
        type: "fs.write",
        path: pathMatch ? pathMatch[1] : "src/index.ts",
        prompt: promptTextSanitize(prompt),
      };
    }

    return {
      type: "fs.read",
      path: "src/main.ts",
      prompt: promptTextSanitize(prompt),
    };
  }
}

function promptTextSanitize(prompt: string): string {
  return prompt.trim().slice(0, 500);
}
