import { FileScanResult } from "./scanner.js";
import { formatSarifJson } from "./sarif.js";

/**
 * Common Exporter interface for all CLI output formats (#1095).
 */
export interface Exporter {
  export(results: FileScanResult[]): string;
}

/**
 * Sanitize cell values to prevent CSV formula injection (=, +, -, @).
 */
function sanitizeCsvCell(value: string): string {
  if (/^[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

export class CsvExporter implements Exporter {
  export(results: FileScanResult[]): string {
    const rows: string[] = ["Path,Line,Severity,Type,Reason,Text"];
    for (const res of results) {
      for (const v of res.violations) {
        const path = sanitizeCsvCell(res.path);
        const line = sanitizeCsvCell(String(v.line));
        const severity = sanitizeCsvCell(v.severity ?? "HIGH");
        const type = sanitizeCsvCell(v.type ?? "Secret");
        const reason = sanitizeCsvCell(v.reason ?? "");
        const text = sanitizeCsvCell(v.text ?? "");
        rows.push(`"${path}","${line}","${severity}","${type}","${reason}","${text}"`);
      }
    }
    return rows.join("\n");
  }
}

export class MarkdownExporter implements Exporter {
  export(results: FileScanResult[]): string {
    let md = "# SecureFlow Security Scan Report\n\n";
    md += "| File Path | Line | Severity | Type | Reason |\n";
    md += "|-----------|------|----------|------|--------|\n";
    for (const res of results) {
      for (const v of res.violations) {
        md += `| \`${res.path}\` | ${v.line} | **${v.severity ?? "HIGH"}** | ${v.type ?? "Secret"} | ${v.reason ?? ""} |\n`;
      }
    }
    return md;
  }
}

export class SarifExporter implements Exporter {
  export(results: FileScanResult[]): string {
    return formatSarifJson(results);
  }
}

/**
 * Factory function to get the appropriate exporter instance.
 */
export function getExporter(format: string): Exporter {
  switch (format.toLowerCase()) {
    case "csv":
      return new CsvExporter();
    case "markdown":
    case "md":
      return new MarkdownExporter();
    case "sarif":
      return new SarifExporter();
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}