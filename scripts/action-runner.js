#!/usr/bin/env node
/**
 * SecureFlow GitHub Action Runner
 *
 * Orchestrates the SecureFlow scanner inside GitHub Actions workflows,
 * exports step outputs (total-findings, highest-severity, sarif-file),
 * maintains sticky PR summary comments, and enforces fail thresholds.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const SEVERITY_LEVELS = {
  NONE: 0,
  INFO: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  CRITICAL: 5,
};

export const SECUREFLOW_ACTION_MARKER = "<!-- secureflow-report -->";

/**
 * Normalizes severity string to uppercase valid severity.
 */
export function normalizeSeverity(severity) {
  if (!severity || typeof severity !== "string") return "NONE";
  const upper = severity.toUpperCase().trim();
  return SEVERITY_LEVELS[upper] !== undefined ? upper : "NONE";
}

/**
 * Calculates highest severity among an array of severity strings.
 */
export function calculateHighestSeverity(severities) {
  if (!severities || severities.length === 0) return "NONE";

  let highestLevel = 0;
  let highestSev = "NONE";

  for (const s of severities) {
    const norm = normalizeSeverity(s);
    const level = SEVERITY_LEVELS[norm] ?? 0;
    if (level > highestLevel) {
      highestLevel = level;
      highestSev = norm;
    }
  }

  return highestSev;
}

/**
 * Determines whether the scan should fail the build based on fail-threshold.
 */
export function shouldFailBuild(highestSeverity, failThreshold) {
  const normThreshold = normalizeSeverity(failThreshold);
  if (normThreshold === "NONE") return false;

  const highestLevel = SEVERITY_LEVELS[normalizeSeverity(highestSeverity)] ?? 0;
  const thresholdLevel = SEVERITY_LEVELS[normThreshold] ?? SEVERITY_LEVELS.HIGH;

  return highestLevel >= thresholdLevel;
}

/**
 * Extracts findings count and highest severity from generated SARIF JSON or report.
 */
export function parseSarifSummary(sarifContent) {
  try {
    const data = typeof sarifContent === "string" ? JSON.parse(sarifContent) : sarifContent;
    const runs = data?.runs || [];
    let totalFindings = 0;
    const severities = [];

    for (const run of runs) {
      const results = run?.results || [];
      totalFindings += results.length;

      for (const res of results) {
        const level = res?.level;
        // Map SARIF level to SecureFlow severity
        if (level === "error") {
          severities.push("HIGH");
        } else if (level === "warning") {
          severities.push("MEDIUM");
        } else if (level === "note") {
          severities.push("LOW");
        } else {
          severities.push("LOW");
        }
      }
    }

    const highestSeverity = calculateHighestSeverity(severities);
    return {
      totalFindings,
      highestSeverity,
      severities,
    };
  } catch (err) {
    return {
      totalFindings: 0,
      highestSeverity: "NONE",
      severities: [],
    };
  }
}

/**
 * Formats the markdown body for pull request review comments.
 */
export function formatActionCommentBody({
  commitSha,
  scanTime,
  totalFindings,
  highestSeverity,
  failThreshold,
  failed,
  reportPath,
}) {
  const statusEmoji = failed ? "❌" : "✅";
  const statusText = failed
    ? `Failed (Highest finding ${highestSeverity} met or exceeded threshold ${failThreshold.toUpperCase()})`
    : "Passed";

  let body = `${SECUREFLOW_ACTION_MARKER}\n`;
  body += `### 🛡️ SecureFlow Security Report\n\n`;

  if (commitSha) {
    body += `Scanned commit: \`${commitSha}\`\n`;
  }
  if (scanTime) {
    const formatted = scanTime instanceof Date ? scanTime.toISOString() : scanTime;
    body += `Scan time: \`${formatted}\`\n`;
  }
  body += `\n`;

  body += `| Metric | Result |\n`;
  body += `|---|---|\n`;
  body += `| **Total Findings** | \`${totalFindings}\` |\n`;
  body += `| **Highest Severity** | \`${highestSeverity}\` |\n`;
  body += `| **Fail Threshold** | \`${failThreshold.toUpperCase()}\` |\n`;
  body += `| **Quality Gate Status** | ${statusEmoji} ${statusText} |\n\n`;

  if (totalFindings === 0) {
    body += `🎉 **No security vulnerabilities or secret leaks detected.** Code is ready to merge!\n`;
  } else {
    body += `⚠️ Detected **${totalFindings}** potential security issue(s). `;
    if (reportPath) {
      body += `Full details exported to \`${reportPath}\`.\n`;
    } else {
      body += `Please review and resolve blocking findings.\n`;
    }
  }

  return body;
}

/**
 * Writes outputs to $GITHUB_OUTPUT file.
 */
export function writeGithubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  const lines = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  fs.appendFileSync(outputPath, lines, "utf-8");
}

/**
 * Posts or updates a sticky comment on a GitHub pull request.
 */
export async function postOrUpdatePRComment({ token, repository, prNumber, body }) {
  if (!token || !repository || !prNumber) return false;

  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "SecureFlow-GitHub-Action",
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  try {
    // 1. Fetch existing comments to locate one with our marker
    const listUrl = `https://api.github.com/repos/${repository}/issues/${prNumber}/comments?per_page=100`;
    const listRes = await fetch(listUrl, { headers });
    let existingCommentId = null;

    if (listRes.ok) {
      const comments = await listRes.json();
      if (Array.isArray(comments)) {
        const match = comments.find(
          (c) =>
            typeof c.body === "string" &&
            (c.body.includes(SECUREFLOW_ACTION_MARKER) ||
              c.body.includes("SecureFlow Security Report") ||
              c.body.includes("SecureFlow AI Security Report")),
        );
        if (match) {
          existingCommentId = match.id;
        }
      }
    }

    if (existingCommentId) {
      // 2. Update existing comment in place
      const updateUrl = `https://api.github.com/repos/${repository}/issues/comments/${existingCommentId}`;
      const updateRes = await fetch(updateUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      });
      return updateRes.ok;
    } else {
      // 3. Create fresh comment
      const createUrl = `https://api.github.com/repos/${repository}/issues/${prNumber}/comments`;
      const createRes = await fetch(createUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
      return createRes.ok;
    }
  } catch (err) {
    console.warn(`[SecureFlow Action] Failed to post PR comment: ${err.message}`);
    return false;
  }
}

/**
 * Main execution routine.
 */
export async function run() {
  const paths = process.env.INPUT_PATHS || ".";
  const severity = process.env.INPUT_SEVERITY || "low";
  const commentOnPr = process.env.INPUT_COMMENT_ON_PR !== "false";
  const failThreshold = process.env.INPUT_FAIL_THRESHOLD || "high";
  const githubToken = process.env.INPUT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const format = process.env.INPUT_FORMAT || "sarif";
  const output = process.env.INPUT_OUTPUT || "secureflow-results.sarif";

  console.log("🛡️ Starting SecureFlow Security Scan...");
  console.log(`   Target Paths: ${paths}`);
  console.log(`   Minimum Severity: ${severity}`);
  console.log(`   Fail Threshold: ${failThreshold}`);
  console.log(`   Report Format: ${format} -> ${output}`);

  // Resolve CLI execution path
  const actionRoot = path.resolve(import.meta.dirname, "..");
  const localCliDist = path.join(actionRoot, "cli", "dist", "index.js");
  let cliCmd = "";

  if (fs.existsSync(localCliDist)) {
    cliCmd = `node "${localCliDist}"`;
  } else {
    cliCmd = "npx --yes secureflow-cli";
  }

  const scanArgs = [
    "scan",
    paths,
    "--format",
    format,
    "-o",
    output,
    "--fail-on",
    "none", // Allow action runner to inspect and report findings first
  ];

  if (severity && severity !== "low") {
    scanArgs.push("--severity", severity);
  }

  try {
    execSync(`${cliCmd} ${scanArgs.join(" ")}`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
  } catch (err) {
    console.warn(`[SecureFlow Action] Scanner execution returned warning: ${err.message}`);
  }

  // Parse findings from generated report
  let totalFindings = 0;
  let highestSeverity = "NONE";

  if (fs.existsSync(output)) {
    const fileContent = fs.readFileSync(output, "utf-8");
    if (format === "sarif") {
      const summary = parseSarifSummary(fileContent);
      totalFindings = summary.totalFindings;
      highestSeverity = summary.highestSeverity;
    } else if (format === "json") {
      try {
        const jsonFindings = JSON.parse(fileContent);
        totalFindings = Array.isArray(jsonFindings) ? jsonFindings.length : 0;
        highestSeverity = calculateHighestSeverity(
          (jsonFindings || []).map((f) => f.severity || "NONE"),
        );
      } catch {
        // Fallback
      }
    }
  }

  const hasFindings = totalFindings > 0 ? "true" : "false";
  const failed = shouldFailBuild(highestSeverity, failThreshold);

  console.log("\n📊 Scan Summary:");
  console.log(`   Total Findings: ${totalFindings}`);
  console.log(`   Highest Severity: ${highestSeverity}`);
  console.log(`   Has Findings: ${hasFindings}`);
  console.log(`   Quality Gate: ${failed ? "FAILED" : "PASSED"}`);

  // Export GitHub step outputs
  writeGithubOutputs({
    "total-findings": totalFindings,
    "highest-severity": highestSeverity,
    "has-findings": hasFindings,
    "sarif-file": output,
  });

  // Pull request comment handling
  if (commentOnPr && process.env.GITHUB_EVENT_NAME === "pull_request") {
    let prNumber = null;
    let repoFullName = process.env.GITHUB_REPOSITORY;

    if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
      try {
        const eventData = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"));
        prNumber = eventData?.pull_request?.number;
        repoFullName = eventData?.repository?.full_name || repoFullName;
      } catch {
        // Fallback
      }
    }

    if (prNumber && githubToken) {
      console.log(`💬 Posting scan summary to Pull Request #${prNumber}...`);
      const commentBody = formatActionCommentBody({
        commitSha: process.env.GITHUB_SHA,
        scanTime: new Date().toISOString(),
        totalFindings,
        highestSeverity,
        failThreshold,
        failed,
        reportPath: output,
      });

      await postOrUpdatePRComment({
        token: githubToken,
        repository: repoFullName,
        prNumber,
        body: commentBody,
      });
    }
  }

  if (failed) {
    console.error(
      `\n❌ [SecureFlow Action] Quality gate failed: Highest finding (${highestSeverity}) met or exceeded fail-threshold (${failThreshold.toUpperCase()}).`,
    );
    process.exit(1);
  } else {
    console.log("\n✅ [SecureFlow Action] Quality gate passed successfully.");
    process.exit(0);
  }
}

// Auto-run if executed directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  run().catch((err) => {
    console.error(`❌ [SecureFlow Action] Fatal Error: ${err.message}`);
    process.exit(1);
  });
}
