#!/usr/bin/env tsx
/**
 * Scanner Stability & Flakiness Evaluation Suite (#2009)
 *
 * Runs each golden sample N times (default: 5) against the LLM scanner and evaluates
 * the variance/flakiness of model responses across runs.
 *
 * Emits a structured stability report with per-sample stability percentages, highlights
 * failing runs below a configurable stability threshold (default: 80%), and publishes
 * an evaluation table to GITHUB_STEP_SUMMARY when executed within GitHub Actions.
 *
 * Usage:
 *   npx tsx scripts/test-scanner-stability.ts
 *   npx tsx scripts/test-scanner-stability.ts --runs=5 --threshold=80
 *   npx tsx scripts/test-scanner-stability.ts --sample=sql-injection --runs=3
 */

import fs from "node:fs";
import Groq from "groq-sdk";
import {
  PROMPT_REGRESSION_SAMPLES,
  evaluateSampleMatch,
  type PromptRegressionSample,
  type SampleEvaluationResult,
} from "../src/lib/armor/__fixtures__";
import {
  ArmorIQScanner,
  resolveScanModel,
  extractAddedLines,
  type ScanFinding,
  type ScannerPolicy,
} from "../src/lib/armor/scanner";
import { parseFindingType } from "../src/lib/finding-taxonomy";

export interface StabilityOptions {
  runs?: number;
  threshold?: number; // percentage (0-100), default 80
  sampleId?: string;
  model?: string;
  maxSamples?: number;
  help?: boolean;
}

export interface SampleRunOutcome {
  runIndex: number;
  detectedCount: number;
  passed: boolean;
  actualCategories: string[];
  actualSeverities: string[];
  reason: string;
}

export interface SampleStabilityResult {
  sampleId: string;
  sampleName: string;
  filename: string;
  shouldDetect: boolean;
  expectedCategory?: string;
  totalRuns: number;
  successfulRuns: number;
  stabilityPercentage: number;
  passed: boolean; // stabilityPercentage >= threshold
  outcomes: SampleRunOutcome[];
}

export interface StabilitySuiteSummary {
  model: string;
  runsPerSample: number;
  threshold: number;
  totalSamples: number;
  passedSamples: number;
  failedSamples: number;
  overallStabilityPercentage: number;
  allPassed: boolean;
  results: SampleStabilityResult[];
}

export function parseStabilityArgs(args: string[]): StabilityOptions {
  const options: StabilityOptions = {};
  for (const arg of args) {
    if (arg.startsWith("--runs=")) {
      const val = parseInt(arg.split("=")[1], 10);
      if (!isNaN(val) && val > 0) options.runs = val;
    } else if (arg.startsWith("--threshold=")) {
      const val = parseFloat(arg.split("=")[1]);
      if (!isNaN(val) && val >= 0 && val <= 100) options.threshold = val;
    } else if (arg.startsWith("--sample=")) {
      options.sampleId = arg.split("=")[1];
    } else if (arg.startsWith("--model=")) {
      options.model = arg.split("=")[1];
    } else if (arg.startsWith("--max-samples=")) {
      const val = parseInt(arg.split("=")[1], 10);
      if (!isNaN(val) && val > 0) options.maxSamples = val;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

/**
 * Builds the batch prompt sent to the model for a sample.
 */
export function buildSamplePrompt(
  filename: string,
  patch: string,
  policies: ScannerPolicy[] = [],
): string {
  let policyInstructions = `CORE RULES:\n1. Hardcoded secrets (actual active production string values).\n2. Contextual leaks (explicitly logging secret variables to the console or exposing them to clients).`;

  if (policies && policies.length > 0) {
    policyInstructions += `\n\nCUSTOM POLICIES TO ENFORCE:\n`;
    policies.forEach((policy, index) => {
      policyInstructions += `- Rule ${index + 1}: ${policy.description}\n`;
    });
  } else {
    policyInstructions += `\n\nCRITICAL: DO NOT focus on or flag general vulnerabilities like SQL injection, XSS, or logic flaws. ONLY FOCUS ON THE DEFAULT SECRET-RELATED ISSUES ABOVE.`;
  }

  const addedLines = extractAddedLines(patch);
  const fileContentBlock = `<file name="${filename}" context_warning="">\n${addedLines}\n</file>\n\n`;

  return `Analyze the following aggregated code changes from a Pull Request for security vulnerabilities.
Enforce the following configured issues, AND ALSO flag any other critical executable vulnerabilities (like SQL Injection, XSS, etc) even if they are not explicitly listed below:

${policyInstructions}

The changes are organized under individual <file> tags. 
CRITICAL RULES SCOPED BY FILE TYPE:
- For '.env.example' or '.env' files: ONLY flag a line if the right side of the equals sign contains a REAL, active credential (e.g., a long random alphanumeric string, a hash, or a valid token). DO NOT flag lines with descriptive text, empty quotes, or generic placeholders.
- For '.ts' or '.js' files: You MUST flag any instance of 'console.log(process.env...)' as a CRITICAL contextual leak or any 'console.log(<variable>)' where the 'variable' is instantiated with 'process.env...'.

Aggregated Code Changes:
${fileContentBlock}
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
}

/**
 * Calculates stability metrics for a given sample across multiple run evaluation results.
 */
export function calculateSampleStability(
  sample: PromptRegressionSample,
  outcomes: SampleRunOutcome[],
  threshold: number,
): SampleStabilityResult {
  const totalRuns = outcomes.length;
  const successfulRuns = outcomes.filter((o) => o.passed).length;
  const stabilityPercentage =
    totalRuns > 0 ? Math.round((successfulRuns / totalRuns) * 1000) / 10 : 0;
  const passed = stabilityPercentage >= threshold;

  return {
    sampleId: sample.id,
    sampleName: sample.name,
    filename: sample.filename,
    shouldDetect: sample.expected.shouldDetect,
    expectedCategory: sample.expected.category,
    totalRuns,
    successfulRuns,
    stabilityPercentage,
    passed,
    outcomes,
  };
}

/**
 * Formats stability summary report into Markdown for console or GitHub Step Summary.
 */
export function formatStabilityMarkdownSummary(summary: StabilitySuiteSummary): string {
  const lines: string[] = [];

  lines.push(`## 🎯 Scanner LLM Stability Evaluation Report`);
  lines.push("");
  lines.push(
    `Evaluated **${summary.totalSamples}** golden sample fixtures across **${summary.runsPerSample} iterations each** against model \`${summary.model}\`.`,
  );
  lines.push("");

  const statusBadge = summary.allPassed
    ? "✅ **PASS: All samples met or exceeded stability threshold.**"
    : `❌ **FAIL: ${summary.failedSamples} of ${summary.totalSamples} samples fell below stability threshold (${summary.threshold}%).**`;

  lines.push(statusBadge);
  lines.push("");
  lines.push(
    `| Sample ID | Category / Expectation | Success / Runs | Stability (%) | Threshold | Status |`,
  );
  lines.push(`| :--- | :--- | :---: | :---: | :---: | :---: |`);

  for (const r of summary.results) {
    const expectation = r.shouldDetect
      ? `Detect \`${r.expectedCategory || "Finding"}\``
      : `Clean (0 Findings)`;
    const statusText = r.passed ? "✅ PASS" : "❌ FAIL";
    const percentFormatted = `${r.stabilityPercentage.toFixed(1)}%`;

    lines.push(
      `| **${r.sampleId}**<br>_${r.sampleName}_ | ${expectation} | ${r.successfulRuns}/${r.totalRuns} | **${percentFormatted}** | ${summary.threshold}% | ${statusText} |`,
    );

    if (!r.passed) {
      const failedRuns = r.outcomes.filter((o) => !o.passed);
      const reasons = Array.from(new Set(failedRuns.map((f) => f.reason))).slice(0, 2);
      for (const reason of reasons) {
        lines.push(`| ↳ ⚠️ *${reason.replace(/\|/g, "\\|")}* | | | | | |`);
      }
    }
  }

  lines.push("");
  lines.push(`### Summary Metrics`);
  lines.push(`- **Overall Average Stability:** ${summary.overallStabilityPercentage.toFixed(1)}%`);
  lines.push(`- **Required Stability Threshold:** ${summary.threshold}%`);
  lines.push(`- **Stable Samples:** ${summary.passedSamples} / ${summary.totalSamples}`);
  lines.push(`- **Unstable / Flaky Samples:** ${summary.failedSamples}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Executes stability evaluation suite with configurable model client.
 */
export async function runStabilityEvaluation(
  options: StabilityOptions = {},
  dependencies?: {
    groqClient?: Groq;
    samples?: PromptRegressionSample[];
  },
): Promise<StabilitySuiteSummary> {
  const runs = options.runs ?? 5;
  const threshold = options.threshold ?? 80;
  const selectedModel = options.model || resolveScanModel();

  let targetSamples = dependencies?.samples || PROMPT_REGRESSION_SAMPLES;
  if (options.sampleId) {
    targetSamples = targetSamples.filter((s) => s.id === options.sampleId);
    if (targetSamples.length === 0) {
      throw new Error(`Sample with ID '${options.sampleId}' not found.`);
    }
  }

  if (options.maxSamples && options.maxSamples > 0) {
    targetSamples = targetSamples.slice(0, options.maxSamples);
  }

  const results: SampleStabilityResult[] = [];
  const groq = dependencies?.groqClient || new Groq({ apiKey: process.env.GROQ_API_KEY });
  const scanner = new ArmorIQScanner();

  for (const sample of targetSamples) {
    const outcomes: SampleRunOutcome[] = [];

    for (let i = 1; i <= runs; i++) {
      try {
        const prompt = buildSamplePrompt(sample.filename, sample.patch, sample.policies);
        const completion = await groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `You are an authorized defensive security auditing tool. Output valid JSON only.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          model: selectedModel,
          temperature: 0.1,
          response_format: { type: "json_object" },
        });

        const rawText = completion.choices[0]?.message?.content || "{}";
        let parsedFindings: any[] = [];
        try {
          const parsed = JSON.parse(rawText);
          parsedFindings = parsed.findings || (Array.isArray(parsed) ? parsed : []);
        } catch {
          parsedFindings = [];
        }

        // Format findings through standard normalizer
        const normalizedFindings: ScanFinding[] = parsedFindings.map((f: any) => ({
          type: String(f.type || "Vulnerability"),
          severity: (f.severity || "MEDIUM") as any,
          description: f.description || "",
          fileLocation: f.fileLocation || sample.filename,
          codeSnippet: f.codeSnippet || "",
          confidence: f.confidence,
        }));

        const evaluation = evaluateSampleMatch(sample, normalizedFindings);
        outcomes.push({
          runIndex: i,
          detectedCount: evaluation.detectedCount,
          passed: evaluation.passed,
          actualCategories: evaluation.actualCategories,
          actualSeverities: evaluation.actualSeverities,
          reason: evaluation.reason,
        });
      } catch (err: any) {
        outcomes.push({
          runIndex: i,
          detectedCount: 0,
          passed: false,
          actualCategories: [],
          actualSeverities: [],
          reason: `Model API invocation failed: ${err?.message || "Unknown error"}`,
        });
      }
    }

    const sampleResult = calculateSampleStability(sample, outcomes, threshold);
    results.push(sampleResult);
  }

  const passedSamples = results.filter((r) => r.passed).length;
  const failedSamples = results.length - passedSamples;
  const overallStabilityPercentage =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.stabilityPercentage, 0) / results.length
      : 100;
  const allPassed = failedSamples === 0;

  return {
    model: selectedModel,
    runsPerSample: runs,
    threshold,
    totalSamples: results.length,
    passedSamples,
    failedSamples,
    overallStabilityPercentage,
    allPassed,
    results,
  };
}

/**
 * Main script runner
 */
export async function main(): Promise<void> {
  const options = parseStabilityArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`
Scanner LLM Stability Evaluation Suite (#2009)

Options:
  --runs=<number>        Number of iterations per sample (default: 5)
  --threshold=<number>   Minimum stability percentage required to pass (default: 80)
  --sample=<sampleId>    Target specific sample ID
  --max-samples=<number> Cap total number of samples evaluated (to conserve cost)
  --model=<modelName>    Target model name
  --help, -h             Show this help message
`);
    process.exit(0);
  }

  const apiKey = process.env.GROQ_API_KEY;
  const isMockKey =
    !apiKey ||
    apiKey === "dummy-key-for-build" ||
    apiKey === "test-key" ||
    apiKey === "mock_api_key" ||
    apiKey.toLowerCase().includes("mock") ||
    apiKey.toLowerCase().includes("test");

  if (isMockKey) {
    console.log(
      "ℹ️  GROQ_API_KEY is not set or contains a placeholder key. Skipping live stability evaluation.",
    );
    process.exit(0);
  }

  console.log("🚀 Starting Scanner LLM Stability Evaluation...");
  try {
    const summary = await runStabilityEvaluation(options);
    const markdown = formatStabilityMarkdownSummary(summary);
    console.log("\n" + markdown);

    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummaryPath) {
      try {
        fs.appendFileSync(stepSummaryPath, markdown + "\n");
        console.log(`\n✅ Published stability summary to GITHUB_STEP_SUMMARY.`);
      } catch (err) {
        console.warn("Could not write to GITHUB_STEP_SUMMARY:", err);
      }
    }

    if (!summary.allPassed) {
      console.error(
        `\n❌ Stability check failed: ${summary.failedSamples} of ${summary.totalSamples} samples did not meet the ${summary.threshold}% stability threshold.`,
      );
      process.exit(1);
    }

    console.log("\n✅ All samples met the stability threshold.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Fatal error during stability evaluation:", error);
    process.exit(1);
  }
}

// Execute if run directly via CLI
if (
  process.argv[1] &&
  (process.argv[1].endsWith("test-scanner-stability.ts") ||
    process.argv[1].includes("test-scanner-stability"))
) {
  main();
}
