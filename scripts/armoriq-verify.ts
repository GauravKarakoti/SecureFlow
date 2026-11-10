/**
 * ArmorIQ Verification & Policy Gate Script (#1710)
 *
 * Scans staged changes, git log, or environment PR metadata against ArmorIQ policy rules
 * and outputs compliance scores. Used by CI workflows to enforce block/warn quality gates.
 */

import { ArmorIQGuardrailService, PolicyEvaluationContext } from "../src/lib/armoriq-guardrails";
import { execSync } from "node:child_process";

export interface CliCheckOptions {
  prNumber?: number;
  strict?: boolean;
  blockThreshold?: number;
  warnThreshold?: number;
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
      changedFiles = diffOutput.split("\n").map((s) => s.trim()).filter(Boolean);
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
      diffSnippets = patchOutput.split("\n").filter((l) => l.startsWith("+")).slice(0, 500);
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
  } catch (error) {
    return {
      changedFiles: [],
      diffSnippets: [],
    };
  }
}

export async function runArmorIQCheck(options: CliCheckOptions = {}) {
  const guardrails = new ArmorIQGuardrailService();
  const context = collectGitContext();

  console.log("🛡️  Evaluating ArmorIQ Intent & Policy Guardrails (#1710)...");
  if (context.changedFiles && context.changedFiles.length > 0) {
    console.log(`📁 Files evaluated (${context.changedFiles.length}): ${context.changedFiles.slice(0, 5).join(", ")}${context.changedFiles.length > 5 ? "..." : ""}`);
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
  runArmorIQCheck().catch((err) => {
    console.error("Fatal error during ArmorIQ verification:", err);
    process.exit(1);
  });
}
