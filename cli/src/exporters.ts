/**
 * Unified Exporters for SecureFlow CLI (#1095)
 *
 * Provides a common Exporter interface and formatters for CSV, Markdown,
 * HTML, and SARIF formats with robust security escaping and formula injection prevention.
 */

import type { FileScanResult } from "./scanner.js";
import { formatSarifJson } from "./sarif.js";

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

// ---------------------------------------------------------------------------
// Exporter Interface & Implementations (#1095)
// ---------------------------------------------------------------------------

export interface Exporter {
  export(results: FileScanResult[]): string;
}

export class CsvExporter implements Exporter {
  export(results: FileScanResult[]): string {
    const CSV_HEADERS = "File,Line,Violation,Reason";
    const rows: string[] = [CSV_HEADERS];

    for (const file of results) {
      for (const v of file.violations) {
        rows.push(
          [escapeCsv(file.path), String(v.line), escapeCsv(v.text), escapeCsv(v.reason)].join(","),
        );
      }
    }
    return rows.join("\n") + "\n";
  }
}

export class MarkdownExporter implements Exporter {
  export(results: FileScanResult[]): string {
    const violations: { path: string; line: number; text: string; reason: string }[] = [];

    for (const file of results) {
      for (const v of file.violations) {
        violations.push({ path: file.path, line: v.line, text: v.text, reason: v.reason });
      }
    }

    const lines: string[] = ["# 🛡️ SecureFlow Scan Report", ""];

    if (violations.length === 0) {
      lines.push("✅ **No violations detected.**");
      lines.push("");
      return lines.join("\n");
    }

    lines.push(`Found **${violations.length}** violation${violations.length === 1 ? "" : "s"}.`);
    lines.push("");
    lines.push("| File | Line | Violation | Reason |");
    lines.push("| --- | --- | --- | --- |");

    for (const v of violations) {
      const file = escapeMarkdownTable(v.path);
      const line = v.line;
      const text = toMarkdownCodeSpan(v.text);
      const reason = escapeMarkdownTable(v.reason);
      lines.push(`| ${file} | ${line} | ${text} | ${reason} |`);
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
        violations.push({ path: file.path, line: v.line, text: v.text, reason: v.reason });
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
  export(results: FileScanResult[]): string {
    return formatSarifJson(results);
  }
}

/**
 * Factory function to get the appropriate exporter instance (#1095).
 */
export function getExporter(format: string): Exporter {
  switch (format.toLowerCase()) {
    case "csv":
      return new CsvExporter();
    case "markdown":
    case "md":
      return new MarkdownExporter();
    case "html":
      return new HtmlExporter();
    case "sarif":
      return new SarifExporter();
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}
