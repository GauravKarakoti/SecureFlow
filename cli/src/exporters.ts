/**
 * Unified Exporters for SecureFlow CLI (#1095, #2021)
 *
 * Provides a common Exporter interface and formatters for CSV, Markdown,
 * HTML, SARIF, and JUnit XML formats with robust security escaping,
 * formula injection prevention, and secret masking.
 */

import type { FileScanResult, FailOnSeverity } from "./scanner.js";
import { formatSarifJson } from "./sarif.js";
import { maskSecrets } from "./secret-masker.js";

// ---------------------------------------------------------------------------
// Escape helpers (from main branch)
// ---------------------------------------------------------------------------

const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Escapes a value for safe embedding in a CSV cell per RFC 4180 and CWE-1236.
 */
export function escapeCsv(value: string): string {
  const text = FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger)) ? `'${value}` : value;
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Escapes special HTML characters to prevent XSS.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes characters that break Markdown table syntax.
 */
export function escapeMarkdownTable(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/**
 * Wraps a value in a Markdown code span.
 */
export function toMarkdownCodeSpan(value: string): string {
  const text = value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

/**
 * Escapes special characters for XML and removes control characters invalid in XML 1.0 (#2021).
 */
export function escapeXml(value: string): string {
  return (
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // Remove XML 1.0 disallowed control characters (ASCII 0x00-0x1F except \t 0x09, \n 0x0A, \r 0x0D)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  );
}

// ---------------------------------------------------------------------------
// Exporter Interface & Implementations (#1095, #2021)
// ---------------------------------------------------------------------------

export interface ExporterOptions {
  failOnThreshold?: FailOnSeverity | null;
  aiFindings?: any[];
  [key: string]: unknown;
}

export interface Exporter {
  export(results: FileScanResult[], options?: ExporterOptions): string;
}

export class CsvExporter implements Exporter {
  export(results: FileScanResult[]): string {
    const CSV_HEADERS = "File,Line,Violation,Reason";
    const rows: string[] = [CSV_HEADERS];

    for (const file of results) {
      for (const v of file.violations) {
        const reasonText = v.custom
          ? `[Custom Rule: ${v.ruleId || "custom"}] ${v.reason}`
          : v.reason;
        rows.push(
          [
            escapeCsv(file.path),
            String(v.line),
            escapeCsv(maskSecrets(v.text)),
            escapeCsv(reasonText),
          ].join(","),
        );
      }
    }
    return rows.join("\n") + "\n";
  }
}

export class MarkdownExporter implements Exporter {
  export(results: FileScanResult[]): string {
    // Collect all violations deterministically
    const sortedFiles = [...results].sort((a, b) => a.path.localeCompare(b.path));
    const violations: {
      path: string;
      line: number;
      text: string;
      reason: string;
      severity: string;
      ruleId: string;
    }[] = [];

    let countCritical = 0;
    let countHigh = 0;
    let countMedium = 0;
    let countLow = 0;

    for (const file of sortedFiles) {
      const sortedViolations = [...file.violations].sort((a, b) => a.line - b.line);
      for (const v of sortedViolations) {
        const sev = (v.severity || "HIGH").toUpperCase();
        if (sev === "CRITICAL") countCritical++;
        else if (sev === "HIGH") countHigh++;
        else if (sev === "MEDIUM") countMedium++;
        else countLow++;

        const reasonText = v.custom
          ? `[Custom Rule: ${v.ruleId || "custom"}] ${v.reason}`
          : v.reason;
        violations.push({
          path: file.path,
          line: v.line,
          text: maskSecrets(v.text),
          reason: reasonText,
          severity: sev,
          ruleId: v.ruleId || (v.custom ? "custom" : "console-secret-logging"),
        });
      }
    }

    const lines: string[] = ["# 🛡️ SecureFlow Scan Report", ""];

    // Severity summary counts table
    lines.push("### Summary");
    lines.push("");
    lines.push("| Severity | Count |");
    lines.push("| :--- | :--- |");
    lines.push(`| Critical | ${countCritical} |`);
    lines.push(`| High | ${countHigh} |`);
    lines.push(`| Medium | ${countMedium} |`);
    lines.push(`| Low | ${countLow} |`);
    lines.push(`| **Total** | **${violations.length}** |`);
    lines.push("");

    if (violations.length === 0) {
      lines.push("✅ **No violations detected.**");
      lines.push("");
      return lines.join("\n");
    }

    lines.push(`Found **${violations.length}** violation${violations.length === 1 ? "" : "s"}.`);
    lines.push("");
    lines.push("| Severity | Rule | File:Line | Violation | Reason |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const v of violations) {
      const severity = v.severity;
      const rule = escapeMarkdownTable(v.ruleId);
      const fileLine = escapeMarkdownTable(`${v.path}:${v.line}`);
      const text = toMarkdownCodeSpan(v.text);
      const reason = escapeMarkdownTable(v.reason);
      lines.push(`| ${severity} | ${rule} | ${fileLine} | ${text} | ${reason} |`);
    }

    lines.push("");
    return lines.join("\n");
  }
}

export class HtmlExporter implements Exporter {
  export(results: FileScanResult[]): string {
    const violations: { path: string; line: number; text: string; reason: string }[] = [];

    for (const file of results) {
      for (const v of file.violations) {
        const reasonText = v.custom
          ? `[Custom Rule: ${v.ruleId || "custom"}] ${v.reason}`
          : v.reason;
        violations.push({
          path: file.path,
          line: v.line,
          text: maskSecrets(v.text),
          reason: reasonText,
        });
      }
    }

    const tableRows =
      violations.length > 0
        ? violations
            .map(
              (v) =>
                `        <tr>
          <td>${escapeHtml(v.path)}</td>
          <td>${v.line}</td>
          <td><code>${escapeHtml(v.text)}</code></td>
          <td>${escapeHtml(v.reason)}</td>
        </tr>`,
            )
            .join("\n")
        : `        <tr><td colspan="4" class="empty">No violations detected.</td></tr>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecureFlow Scan Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f6f8fa;
      color: #24292f;
      padding: 2rem;
      line-height: 1.5;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .meta { color: #57606a; font-size: 0.875rem; margin-bottom: 1.5rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      overflow: hidden;
    }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #d0d7de; }
    th { background: #f6f8fa; font-weight: 600; font-size: 0.875rem; }
    td code { background: #f0f3f6; padding: 0.125rem 0.375rem; border-radius: 3px; font-size: 0.8125rem; }
    tr:last-child td { border-bottom: none; }
    .empty { text-align: center; color: #57606a; padding: 1.5rem; }
    .summary { margin-top: 1rem; font-size: 0.875rem; color: #57606a; }
    @media print { body { background: #fff; padding: 0; } }
  </style>
</head>
<body>
  <h1>SecureFlow Scan Report</h1>
  <p class="meta">Generated by SecureFlow CLI</p>
  <table>
    <thead>
      <tr>
        <th>File</th>
        <th>Line</th>
        <th>Violation</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>
  <p class="summary">${violations.length} violation${violations.length === 1 ? "" : "s"} found.</p>
</body>
</html>
`;
  }
}

export class SarifExporter implements Exporter {
  export(results: FileScanResult[], options?: ExporterOptions): string {
    return formatSarifJson(results, options);
  }
}

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};

function isBlockingSeverity(severity: string, failOnThreshold?: FailOnSeverity | null): boolean {
  if (failOnThreshold === "NONE") return false;
  const sevUpper = (severity || "HIGH").toUpperCase();
  const sevRank = SEVERITY_RANK[sevUpper] ?? 1;

  if (!failOnThreshold) {
    // Default threshold: HIGH and CRITICAL block
    return sevRank >= 3;
  }
  const thresholdRank = SEVERITY_RANK[failOnThreshold] ?? 3;
  return sevRank >= thresholdRank;
}

/**
 * JUnit XML Exporter (#2021)
 *
 * Produces deterministic JUnit XML test reports adhering to standard JUnit schema,
 * natively consumable by Jenkins, GitLab CI, Azure DevOps, and Bitbucket Pipelines.
 */
export class JunitExporter implements Exporter {
  export(results: FileScanResult[], options?: ExporterOptions): string {
    const sortedFiles = [...results].sort((a, b) => a.path.localeCompare(b.path));
    const failOnThreshold = options?.failOnThreshold;

    let totalTests = 0;
    let totalFailures = 0;

    interface SuiteData {
      name: string;
      tests: number;
      failures: number;
      testcases: string[];
    }

    const suites: SuiteData[] = [];

    for (const file of sortedFiles) {
      const suiteName = file.path;
      const sortedViolations = [...file.violations].sort((a, b) => a.line - b.line);

      // Clean file with no violations produces 1 passed testcase
      if (sortedViolations.length === 0) {
        totalTests += 1;
        suites.push({
          name: suiteName,
          tests: 1,
          failures: 0,
          testcases: [
            `    <testcase name="Security scan: no violations" classname="${escapeXml(suiteName)}" time="0.000" />`,
          ],
        });
        continue;
      }

      let suiteTests = 0;
      let suiteFailures = 0;
      const suiteTestcases: string[] = [];

      for (const v of sortedViolations) {
        suiteTests += 1;
        totalTests += 1;

        const sev = (v.severity || "HIGH").toUpperCase();
        const ruleId = v.ruleId || (v.custom ? "custom" : "console-secret-logging");
        const caseName = `[${ruleId}] line ${v.line}: ${v.reason}`;
        const maskedText = maskSecrets(v.text);
        const blocking = isBlockingSeverity(sev, failOnThreshold);

        if (blocking) {
          suiteFailures += 1;
          totalFailures += 1;
          const failureMessage = escapeXml(`${v.reason} (severity: ${sev})`);
          const failureBody = escapeXml(
            `File: ${file.path}:${v.line}\nSeverity: ${sev}\nRule: ${ruleId}\nViolation: ${maskedText}\nReason: ${v.reason}`,
          );

          suiteTestcases.push(
            `    <testcase name="${escapeXml(caseName)}" classname="${escapeXml(suiteName)}" time="0.000">\n` +
              `      <failure message="${failureMessage}" type="${escapeXml(sev)}">${failureBody}</failure>\n` +
              `    </testcase>`,
          );
        } else {
          // Advisory finding: testcase passes with system-out details
          const infoBody = escapeXml(
            `[ADVISORY] File: ${file.path}:${v.line}\nSeverity: ${sev}\nRule: ${ruleId}\nViolation: ${maskedText}\nReason: ${v.reason}`,
          );
          suiteTestcases.push(
            `    <testcase name="${escapeXml(caseName)}" classname="${escapeXml(suiteName)}" time="0.000">\n` +
              `      <system-out>${infoBody}</system-out>\n` +
              `    </testcase>`,
          );
        }
      }

      suites.push({
        name: suiteName,
        tests: suiteTests,
        failures: suiteFailures,
        testcases: suiteTestcases,
      });
    }

    const xmlLines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="SecureFlow Security Scan" tests="${totalTests}" failures="${totalFailures}" errors="0" time="0.000">`,
    ];

    for (const suite of suites) {
      xmlLines.push(
        `  <testsuite name="${escapeXml(suite.name)}" tests="${suite.tests}" failures="${suite.failures}" errors="0" time="0.000">`,
      );
      for (const tc of suite.testcases) {
        xmlLines.push(tc);
      }
      xmlLines.push("  </testsuite>");
    }

    xmlLines.push("</testsuites>");
    xmlLines.push("");

    return xmlLines.join("\n");
  }
}

export class JsonExporter implements Exporter {
  export(results: FileScanResult[], options?: ExporterOptions): string {
    const sanitizedFiles = results.map((file) => ({
      path: file.path,
      violations: file.violations.map((v) => ({
        ...v,
        text: maskSecrets(v.text),
      })),
    }));

    const sanitizedAiFindings = options?.aiFindings
      ? options.aiFindings.map((af: any) => ({
          ...af,
          description:
            typeof af.description === "string" ? maskSecrets(af.description) : af.description,
          codeSnippet:
            typeof af.codeSnippet === "string" ? maskSecrets(af.codeSnippet) : af.codeSnippet,
        }))
      : undefined;

    return JSON.stringify(
      {
        results: sanitizedFiles,
        ...(sanitizedAiFindings ? { aiFindings: sanitizedAiFindings } : {}),
      },
      null,
      2,
    );
  }
}

/**
 * Factory function to get the appropriate exporter instance (#1095, #2021).
 */
export function getExporter(format: string): Exporter {
  switch (format.toLowerCase()) {
    case "csv":
      return new CsvExporter();
    case "json":
      return new JsonExporter();
    case "markdown":
    case "md":
      return new MarkdownExporter();
    case "html":
      return new HtmlExporter();
    case "sarif":
      return new SarifExporter();
    case "junit":
      return new JunitExporter();
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}
