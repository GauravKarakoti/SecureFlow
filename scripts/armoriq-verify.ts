/**
 * ArmorIQ Verification, Policy Gate & Circuit-Breaker Replay Script (#1710, #1751)
 *
 * Scans staged changes, git log, or environment PR metadata against ArmorIQ policy rules
 * and outputs compliance scores. Also checks circuit breaker recovery and replays unverified
 * remediation intents from the dead-letter queue, ensuring audit chain inclusion.
 */

import { ArmorIQGuardrailService, PolicyEvaluationContext } from "../src/lib/armoriq-guardrails";
import { execSync } from "node:child_process";
import {
  isArmorIQBreakerOpen,
  replayUnverifiedRemediationIntents,
} from "../src/lib/queue/remediationDlq";
import { verifyAuditChain } from "../src/lib/audit/verify-chain";
import prisma from "../src/lib/prisma";

export interface CliCheckOptions {
  prNumber?: number;
  strict?: boolean;
  blockThreshold?: number;
  warnThreshold?: number;
  replayDlq?: boolean;
  verifyAuditChain?: boolean;
}

export function parseCliArgs(argv: string[]): CliCheckOptions {
  const options: CliCheckOptions = {};
  for (const arg of argv) {
    if (arg === "--strict") options.strict = true;
    if (arg === "--no-strict") options.strict = false;
    if (arg === "--replay-dlq") options.replayDlq = true;
    if (arg === "--verify-audit-chain") options.verifyAuditChain = true;
    if (arg.startsWith("--block-threshold=")) {
      options.blockThreshold = Number(arg.split("=")[1]);
    }
    if (arg.startsWith("--warn-threshold=")) {
      options.warnThreshold = Number(arg.split("=")[1]);
    }
  }
  return options;
}

export function checkArmorIQBreakerStatus(): {
  isOpen: boolean;
  state: string;
  recovered: boolean;
} {
  const open = isArmorIQBreakerOpen();
  return {
    isOpen: open,
    state: open ? "OPEN" : "HEALTHY",
    recovered: !open,
  };
}

export async function replayRemediationIntentsFromDlq(
  options: {
    verifyChain?: boolean;
    dbClient?: any;
    verifyIntentTokenFn?: any;
  } = {},
) {
  const breakerStatus = checkArmorIQBreakerStatus();
  if (breakerStatus.isOpen) {
    console.log("⚠️  ArmorIQ Circuit Breaker is OPEN. Replay deferred until health recovers.");
    return { replayed: 0, failed: 0, pending: 0, breakerOpen: true, auditChainValid: null };
  }

  console.log("🔁 Replaying unverified remediation intents from Dead-Letter Queue (#1751)...");
  const replayResult = await replayUnverifiedRemediationIntents({
    dbClient: options.dbClient,
    verifyIntentTokenFn: options.verifyIntentTokenFn,
  });

  console.log(
    `📊 DLQ Replay Complete: ${replayResult.replayed} replayed, ${replayResult.failed} failed, ${replayResult.pending} pending.`,
  );

  let auditChainValid: boolean | null = null;
  if (options.verifyChain !== false && replayResult.replayed > 0) {
    console.log("🔒 Verifying audit chain cryptographic integrity after replay...");
    const chainResult = await verifyAuditChain(options.dbClient || prisma);
    auditChainValid = chainResult.valid;
    if (chainResult.valid) {
      console.log(`✅ Audit chain valid! Total verified: ${chainResult.totalVerified}`);
    } else {
      console.error(`❌ Audit chain verification failed: ${chainResult.reason}`);
    }
  }

  return {
    ...replayResult,
    auditChainValid,
  };
}

export function collectGitContext(): PolicyEvaluationContext {
  try {
    const title = process.env.PR_TITLE || "";
    const description = process.env.PR_BODY || "";
    const author = process.env.PR_AUTHOR || process.env.GITHUB_ACTOR || "";
    const intentToken = process.env.ARMORIQ_INTENT_TOKEN || undefined;

    let changedFiles: string[] = [];
    try {
      const diffOutput = execSync("git diff --name-only origin/main...HEAD", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      changedFiles = diffOutput
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // Fallback: check status or staged files
      try {
        const statusOutput = execSync("git status --porcelain", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        changedFiles = statusOutput
          .split("\n")
          .map((s) => s.trim().replace(/^[A-Z?]+\s+/, ""))
          .filter(Boolean);
      } catch {
        changedFiles = [];
      }
    }

    let diffSnippets: string[] = [];
    try {
      const patchOutput = execSync("git diff -U1 origin/main...HEAD", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1024 * 1024 * 5,
      });
      diffSnippets = patchOutput
        .split("\n")
        .filter((l) => l.startsWith("+"))
        .slice(0, 500);
    } catch {
      diffSnippets = [];
    }

    return {
      title,
      description,
      author,
      changedFiles,
      diffSnippets,
      intentToken,
    };
  } catch {
    return {
      changedFiles: [],
      diffSnippets: [],
    };
  }
}

export async function runArmorIQCheck(options: CliCheckOptions = {}) {
  const breakerStatus = checkArmorIQBreakerStatus();
  if (breakerStatus.isOpen) {
    console.log("⚠️  ArmorIQ Circuit Breaker: [OPEN] (Degraded / Fail-Closed)");
  } else {
    console.log("✅ ArmorIQ Circuit Breaker: [HEALTHY]");
  }

  // Handle dead-letter queue replay if requested
  if (options.replayDlq) {
    await replayRemediationIntentsFromDlq({
      verifyChain: options.verifyAuditChain !== false,
    });
  }

  // Handle explicit audit chain verification
  if (options.verifyAuditChain && !options.replayDlq) {
    console.log("🔒 Verifying audit chain cryptographic integrity...");
    const chainResult = await verifyAuditChain(prisma);
    if (!chainResult.valid) {
      console.error(`❌ Audit chain check failed: ${chainResult.reason}`);
      if (options.strict !== false) {
        process.exit(1);
      }
    } else {
      console.log(`✅ Audit chain valid! Verified ${chainResult.totalVerified} entries.`);
    }
  }

  const guardrails = new ArmorIQGuardrailService();
  const context = collectGitContext();

  console.log("🛡️  Evaluating ArmorIQ Intent & Policy Guardrails (#1710)...");
  if (context.changedFiles && context.changedFiles.length > 0) {
    console.log(
      `📁 Files evaluated (${context.changedFiles.length}): ${context.changedFiles.slice(0, 5).join(", ")}${context.changedFiles.length > 5 ? "..." : ""}`,
    );
  }

  const result = await guardrails.evaluatePullRequest(context, {
    blockScoreThreshold: options.blockThreshold ?? 60,
    warnScoreThreshold: options.warnThreshold ?? 85,
  });

  console.log(`\n📊 ArmorIQ Policy Compliance Score: ${result.complianceScore}/100`);
  console.log(`🚦 Gate Decision: [${result.gateDecision}]`);

  if (result.violations.length > 0) {
    console.log("\n⚠️  Detected Policy Violations:");
    for (const v of result.violations) {
      console.log(`   - [${v.severity}] ${v.ruleId} (${v.ruleName}): ${v.reason}`);
    }
  }

  if (result.gateDecision === "BLOCK") {
    console.error(`\n❌ CI Quality Gate: ${result.summary}`);
    if (options.strict !== false) {
      process.exit(1);
    }
  } else if (result.gateDecision === "WARN") {
    console.warn(`\n⚠️  CI Quality Gate: ${result.summary}`);
  } else {
    console.log(`\n✅ CI Quality Gate: ${result.summary}`);
  }

  return result;
}

const isMain = process.argv[1] && /armoriq-verify(\.ts|\.js)?$/.test(process.argv[1]);
if (isMain) {
  const options = parseCliArgs(process.argv.slice(2));
  runArmorIQCheck(options).catch((err) => {
    console.error("Fatal error during ArmorIQ verification:", err);
    process.exit(1);
  });
}
