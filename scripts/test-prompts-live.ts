#!/usr/bin/env tsx
/**
 * Live Prompt Regression Suite Runner (#1807)
 *
 * Runs code sample fixtures against the live Groq model to detect prompt drift,
 * regression, or unexpected detection differences.
 *
 * Opt-in only: Never runs in CI by default. Requires a live GROQ_API_KEY.
 *
 * Usage:
 *   npm run test:prompts:live
 *   GROQ_API_KEY=gsk_... npm run test:prompts:live
 *   GROQ_API_KEY=gsk_... npm run test:prompts:live -- --update
 *   GROQ_API_KEY=gsk_... npm run test:prompts:live -- --sample=sql-injection
 */

import Groq from "groq-sdk";
import {
  PROMPT_REGRESSION_SAMPLES,
  getRecordedResponse,
  saveRecordedResponse,
  evaluateSampleMatch,
  type PromptRegressionSample,
  type RecordedLlmResponse,
} from "../src/lib/armor/__fixtures__";
import {
  ArmorIQScanner,
  resolveScanModel,
  extractAddedLines,
  type ScannerPolicy,
} from "../src/lib/armor/scanner";
import { parseFindingType } from "../src/lib/finding-taxonomy";

// ANSI colors for readable terminal formatting
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export interface LiveTestCliOptions {
  update?: boolean;
  sampleId?: string;
  model?: string;
  help?: boolean;
}

export function parseArgs(args: string[]): LiveTestCliOptions {
  const options: LiveTestCliOptions = {};
  for (const arg of args) {
    if (arg === "--update" || arg === "-u" || arg === "--refresh") {
      options.update = true;
    } else if (arg.startsWith("--sample=")) {
      options.sampleId = arg.split("=")[1];
    } else if (arg.startsWith("--model=")) {
      options.model = arg.split("=")[1];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

/**
 * Builds the exact prompt sent to the LLM by the scanner for the given file and policies.
 */
export function buildBatchPrompt(
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

export function generateDiffReport(
  expectedRecorded: RecordedLlmResponse,
  liveResponse: RecordedLlmResponse,
): string[] {
  const diffs: string[] = [];

  const recCount = expectedRecorded.findings.length;
  const liveCount = liveResponse.findings.length;

  if (recCount !== liveCount) {
    diffs.push(
      `Finding count changed: recorded had ${bold(String(recCount))}, live returned ${bold(String(liveCount))}.`,
    );
  }

  const minCommon = Math.min(recCount, liveCount);
  for (let i = 0; i < minCommon; i++) {
    const rf = expectedRecorded.findings[i];
    const lf = liveResponse.findings[i];

    if (rf.type !== lf.type) {
      diffs.push(`Finding #${i + 1} type changed: recorded '${rf.type}' vs live '${lf.type}'`);
    }
    if (rf.severity !== lf.severity) {
      diffs.push(
        `Finding #${i + 1} severity changed: recorded '${rf.severity}' vs live '${lf.severity}'`,
      );
    }
  }

  return diffs;
}

export async function runLivePromptSuite(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`
${bold("SecureFlow Live Prompt Regression Suite")}

Usage:
  npm run test:prompts:live [options]

Options:
  --update, -u        Update recorded fixture JSON files with live model responses
  --sample=<id>       Run test on a single sample by its ID
  --model=<model>     Specify custom Groq model (defaults to AI_MODEL or DEFAULT_SCAN_MODEL)
  --help, -h          Show this help message
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
      yellow("ℹ️  Opt-in check: Skipping live prompt regression tests.") +
        "\n   GROQ_API_KEY is not set or contains a test/placeholder key." +
        "\n   These tests make live calls to Groq and are never run in CI by default.\n",
    );
    console.log(cyan("To execute live prompt regression tests against the real Groq model:"));
    console.log("   GROQ_API_KEY=gsk_... npm run test:prompts:live\n");
    console.log(cyan("To refresh recorded fixtures after changing scanner prompts or model:"));
    console.log("   GROQ_API_KEY=gsk_... npm run test:prompts:live -- --update\n");
    process.exit(0);
  }

  const selectedModel = options.model || resolveScanModel();
  console.log(
    bold("\n================================================================================"),
  );
  console.log(bold("  🔍 SecureFlow Scanner Prompt Regression Suite (Live LLM)"));
  console.log(`  Model: ${cyan(selectedModel)}`);
  if (options.update) {
    console.log(`  Mode:  ${yellow("RECORD / UPDATE FIXTURES (--update enabled)")}`);
  } else {
    console.log(`  Mode:  VERIFY & DRIFT DETECTION`);
  }
  console.log(
    bold("================================================================================\n"),
  );

  let targetSamples = PROMPT_REGRESSION_SAMPLES;
  if (options.sampleId) {
    targetSamples = PROMPT_REGRESSION_SAMPLES.filter((s) => s.id === options.sampleId);
    if (targetSamples.length === 0) {
      console.error(red(`❌ Sample with ID '${options.sampleId}' not found.`));
      process.exit(1);
    }
  }

  const groq = new Groq({ apiKey });
  const scanner = new ArmorIQScanner();

  let passedCount = 0;
  let failedCount = 0;
  let driftedCount = 0;
  let updatedCount = 0;

  for (const sample of targetSamples) {
    console.log(`\n${bold("Testing sample:")} ${cyan(sample.id)} (${sample.name})`);
    console.log(`  ${dim("File:")} ${sample.filename}`);

    let recorded: RecordedLlmResponse;
    try {
      recorded = getRecordedResponse(sample.id);
    } catch {
      recorded = { findings: [] };
    }

    try {
      // 1. Query live Groq completion directly for raw response
      const prompt = buildBatchPrompt(sample.filename, sample.patch, sample.policies);
      const completion = await groq.chat.completions.create({
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
        model: selectedModel,
        temperature: 0.1,
        max_tokens: 3000,
      });

      const responseText = completion.choices[0]?.message?.content || '{"findings": []}';
      const cleanJsonString =
        responseText
          .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
          .match(/[\{\[][\s\S]*[\}\]]/)?.[0] || '{"findings": []}';
      const parsedRaw = JSON.parse(cleanJsonString);

      const liveRecordedResponse: RecordedLlmResponse = {
        findings: Array.isArray(parsedRaw)
          ? parsedRaw
          : Array.isArray(parsedRaw.findings)
            ? parsedRaw.findings
            : [],
      };

      // 2. Run standard scanner pipeline for normalized verification
      const scannerFindings = await scanner.scanPullRequest(
        [{ filename: sample.filename, patch: sample.patch }],
        sample.policies,
      );

      // 3. Evaluate criteria
      const evalResult = evaluateSampleMatch(sample, scannerFindings);

      // 4. Check drift against recorded fixture
      const diffs = generateDiffReport(recorded, liveRecordedResponse);

      if (evalResult.passed) {
        passedCount++;
        console.log(`  Status:  ${green("✔ PASS")} - ${evalResult.reason}`);
      } else {
        failedCount++;
        console.log(`  Status:  ${red("✖ FAIL")} - ${evalResult.reason}`);
      }

      if (diffs.length > 0) {
        driftedCount++;
        console.log(`  ${yellow("⚠ DRIFT DETECTED against recorded fixture:")}`);
        for (const diff of diffs) {
          console.log(`    ${yellow("•")} ${diff}`);
        }
      } else {
        console.log(`  ${dim("Diff:")}    ${green("No drift against recorded fixture.")}`);
      }

      // 5. Update fixture if requested
      if (options.update) {
        saveRecordedResponse(sample.id, liveRecordedResponse);
        updatedCount++;
        console.log(`  ${green("💾 Fixture updated successfully.")}`);
      }
    } catch (err: unknown) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Status:  ${red("✖ ERROR")} - ${msg}`);
    }
  }

  console.log(
    bold("\n================================================================================"),
  );
  console.log(bold("  Execution Summary"));
  console.log(
    bold("================================================================================"),
  );
  console.log(`  Total Samples Tested:  ${bold(String(targetSamples.length))}`);
  console.log(`  Passed Expectations:   ${green(String(passedCount))}`);
  console.log(`  Failed Expectations:   ${failedCount > 0 ? red(String(failedCount)) : "0"}`);
  console.log(`  Drifted from Fixtures: ${driftedCount > 0 ? yellow(String(driftedCount)) : "0"}`);
  if (options.update) {
    console.log(`  Fixtures Updated:      ${green(String(updatedCount))}`);
  }
  console.log(
    bold("================================================================================\n"),
  );

  if (failedCount > 0) {
    process.exit(1);
  }
}

// Execute when run directly via tsx
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").includes("test-prompts-live")) {
  runLivePromptSuite().catch((err) => {
    console.error(red("Fatal error in live prompt regression runner:"), err);
    process.exit(1);
  });
}
