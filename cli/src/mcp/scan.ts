import { hasHighEntropy } from "../entropy.js";
import {
  MAX_SCANNED_BYTES,
  formatScanResults,
  lineOf,
  maskStringLiterals,
  readArgumentList,
  scanFile,
  type OutputFormat,
} from "../scanner.js";

const FORMATS = ["json", "text", "sarif", "csv", "html", "markdown", "md"] as const;

export const SCAN_CONTENT_SCHEMA = {
  type: "object" as const,
  properties: {
    content: {
      type: "string",
      maxLength: MAX_SCANNED_BYTES,
      description: "Source supplied by the caller; never read from disk.",
    },
    path: {
      type: "string",
      maxLength: 256,
      description: "Relative report label, not a filesystem path to open. Defaults to input.ts.",
    },
    minEntropy: { type: "number", minimum: 0, maximum: 8, default: 2.8 },
    minTokenLength: { type: "integer", minimum: 8, maximum: 256, default: 16 },
    format: { type: "string", enum: [...FORMATS], default: "json" },
    intentToken: { type: "string" },
  },
  required: ["content"],
  additionalProperties: false,
};

/** Scan one bounded source blob and format redacted findings with the CLI exporters. */
export function scanSuppliedContent(args: Record<string, unknown>) {
  if (Object.keys(args).some((key) => !Object.hasOwn(SCAN_CONTENT_SCHEMA.properties, key))) {
    throw new Error("Unknown scan-content argument");
  }
  if (
    typeof args.content !== "string" ||
    Buffer.byteLength(args.content, "utf8") > MAX_SCANNED_BYTES
  ) {
    throw new Error(`content must be a string of at most ${MAX_SCANNED_BYTES} UTF-8 bytes`);
  }
  if (args.intentToken !== undefined && typeof args.intentToken !== "string") {
    throw new Error("intentToken must be a string");
  }
  const path = args.path === undefined ? "input.ts" : args.path;
  if (
    typeof path !== "string" ||
    path.length > 256 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("path must be a relative report label without empty, dot or parent segments");
  }
  const minEntropy = args.minEntropy === undefined ? 2.8 : args.minEntropy;
  if (
    typeof minEntropy !== "number" ||
    !Number.isFinite(minEntropy) ||
    minEntropy < 0 ||
    minEntropy > 8
  ) {
    throw new Error("minEntropy must be a finite number between 0 and 8");
  }
  const minTokenLength = args.minTokenLength === undefined ? 16 : args.minTokenLength;
  if (
    typeof minTokenLength !== "number" ||
    !Number.isInteger(minTokenLength) ||
    minTokenLength < 8 ||
    minTokenLength > 256
  ) {
    throw new Error("minTokenLength must be an integer between 8 and 256");
  }
  const format = args.format === undefined ? "json" : args.format;
  if (typeof format !== "string" || !FORMATS.includes(format as (typeof FORMATS)[number])) {
    throw new Error("Unsupported scan output format");
  }

  const result = scanFile(path, args.content);
  if (!result.skipped) {
    const masked = maskStringLiterals(args.content);
    const calls = /console\s*\.\s*(?:log|info|warn|error|debug|trace|table|dir)\s*\(/g;
    for (const call of masked.matchAll(calls)) {
      const openParen = call.index + call[0].length - 1;
      const maskedArgs = readArgumentList(masked, openParen);
      if (maskedArgs === null) continue;
      const rawArgs = args.content.slice(openParen + 1, openParen + 1 + maskedArgs.length);
      // Deliberately bounded heuristic for directly quoted ASCII tokens, not a JS evaluator.
      const tokens = rawArgs.matchAll(/(["'`])([A-Za-z0-9_+/=-]{8,256})\1/g);
      if (
        [...tokens].some(
          (match) =>
            maskedArgs[match.index] === match[1] &&
            match[2]!.length >= minTokenLength &&
            hasHighEntropy(match[2]!, minEntropy),
        )
      ) {
        const line = lineOf(masked, call.index);
        if (!result.violations.some((violation) => violation.line === line)) {
          result.violations.push({
            line,
            text: "[source redacted]",
            reason: "high-entropy literal in console call",
            severity: "HIGH",
          });
        }
      }
    }
    result.violations.sort((a, b) => a.line - b.line);
  }
  for (const violation of result.violations) violation.text = "[source redacted]";
  const results = [result];
  return {
    source: "caller_provided",
    format,
    minEntropy,
    minTokenLength,
    violationCount: result.violations.length,
    results,
    report: formatScanResults(results, format as OutputFormat),
  };
}
