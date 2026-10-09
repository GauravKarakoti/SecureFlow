/**
 * SARIF (Static Analysis Results Interchange Format) Exporter for SecureFlow CLI (#728)
 *
 * Converts CLI scan results into standardized OASIS SARIF v2.1.0 schema format
 * for direct ingestion by GitHub Advanced Security, GitLab Security Dashboards, and enterprise CI/CD systems.
 */

// Added `type` prefix for verbatimModuleSyntax compliance
import fs from "node:fs";
import type { Readable } from "node:stream";
import type { FileScanResult } from "./scanner.js";

export interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

export interface SarifRegion {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  snippet?: {
    text: string;
  };
}

export interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

export interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

export interface SarifReportingDescriptor {
  id: string;
  name: string;
  shortDescription: {
    text: string;
  };
  fullDescription?: {
    text: string;
  };
  defaultConfiguration?: {
    level: "error" | "warning" | "note" | "none";
  };
  helpUri?: string;
  properties?: Record<string, unknown>;
}

export interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level: "error" | "warning" | "note" | "none";
  message: {
    text: string;
  };
  locations: SarifLocation[];
  properties?: Record<string, unknown>;
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      organization?: string;
      version?: string;
      semanticVersion?: string;
      informationUri?: string;
      rules: SarifReportingDescriptor[];
    };
  };
  results: SarifResult[];
}

export interface SarifDocument {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

const DEFAULT_RULE_DEFINITIONS: Record<string, SarifReportingDescriptor> = {
  "environment variable": {
    id: "SECUREFLOW-001",
    name: "ConsoleSecretLoggingEnvironmentVariable",
    shortDescription: {
      text: "Console logging of environment variable containing potential secret",
    },
    fullDescription: {
      text: "Passing process.env or other environment variable getters into console methods exposes credentials in build logs or standard output.",
    },
    defaultConfiguration: {
      level: "error",
    },
    helpUri: "https://github.com/GauravKarakoti/SecureFlow#rules",
  },
  "secret-named identifier": {
    id: "SECUREFLOW-002",
    name: "ConsoleSecretLoggingSecretIdentifier",
    shortDescription: {
      text: "Console logging of secret-named identifier or credential parameter",
    },
    fullDescription: {
      text: "Identifiers containing secret, password, apikey, token, or auth parameters passed directly into console logging statements.",
    },
    defaultConfiguration: {
      level: "error",
    },
    helpUri: "https://github.com/GauravKarakoti/SecureFlow#rules",
  },
  "generic-secret-logging": {
    id: "SECUREFLOW-000",
    name: "ConsoleSecretLoggingGeneric",
    shortDescription: {
      text: "Potential secret credential logging in console output",
    },
    defaultConfiguration: {
      level: "error",
    },
    helpUri: "https://github.com/GauravKarakoti/SecureFlow#rules",
  },
};

/**
 * Maps CLI scan results into a valid OASIS SARIF v2.1.0 document object.
 */
export function generateSarifReport(
  scanResults: FileScanResult[],
  options?: {
    toolVersion?: string;
    repoUri?: string;
  },
): SarifDocument {
  const version = options?.toolVersion || "0.1.0";
  const rulesMap = new Map<string, { descriptor: SarifReportingDescriptor; index: number }>();
  const sarifResults: SarifResult[] = [];

  for (const fileResult of scanResults) {
    if (!fileResult.violations || fileResult.violations.length === 0) {
      continue;
    }

    for (const violation of fileResult.violations) {
      const reasonKey = violation.reason || "generic-secret-logging";
      let ruleInfo = rulesMap.get(reasonKey);

      if (!ruleInfo) {
        const descriptor = DEFAULT_RULE_DEFINITIONS[reasonKey] || {
          id: `SECUREFLOW-${rulesMap.size + 100}`,
          name: `ConsoleSecretLoggingCustomRule${rulesMap.size + 1}`,
          shortDescription: {
            text: `Console logging of ${violation.reason}`,
          },
          defaultConfiguration: {
            level: "error",
          },
          helpUri: "https://github.com/GauravKarakoti/SecureFlow#rules",
        };

        ruleInfo = { descriptor, index: rulesMap.size };
        rulesMap.set(reasonKey, ruleInfo);
      }

      sarifResults.push({
        ruleId: ruleInfo.descriptor.id,
        ruleIndex: ruleInfo.index,
        level: ruleInfo.descriptor.defaultConfiguration?.level || "error",
        message: {
          text: `[SecureFlow] ${violation.reason} passed to console call: "${violation.text}"`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: fileResult.path.replace(/\\/g, "/"),
              },
              region: {
                startLine: Math.max(1, violation.line),
                snippet: {
                  text: violation.text,
                },
              },
            },
          },
        ],
        properties: {
          reason: violation.reason,
        },
      });
    }
  }

  const rulesArray = Array.from(rulesMap.values()).map((r) => r.descriptor);
  if (rulesArray.length === 0) {
    // Appended `!` to override 'undefined' error resulting from Record<string, ...> signature
    rulesArray.push(DEFAULT_RULE_DEFINITIONS["generic-secret-logging"]!);
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "SecureFlow CLI",
            semanticVersion: version,
            informationUri: "https://github.com/GauravKarakoti/SecureFlow",
            rules: rulesArray,
          },
        },
        results: sarifResults,
      },
    ],
  };
}

/**
 * Format SARIF report as pretty JSON string.
 */
export function formatSarifJson(
  scanResults: FileScanResult[],
  options?: { toolVersion?: string },
): string {
  const sarifDoc = generateSarifReport(scanResults, options);
  return JSON.stringify(sarifDoc, null, 2);
}

/**
 * Streaming parser options for SARIF processing (#1232).
 */
export interface SarifStreamOptions {
  highWaterMark?: number;
}

/**
 * Stream-based JSON parser for large SARIF reports (#1232).
 *
 * Reads a SARIF report sequentially from an fs.createReadStream or Readable stream,
 * extracting and yielding each `SarifResult` from `runs[].results[]` without
 * loading the entire AST or file into memory.
 *
 * Keeps memory consumption flat (under 150MB) regardless of SARIF file size,
 * preventing Out of Memory (OOM) crashes on constrained CI/CD runners.
 */
export async function* streamSarifResults(
  source: string | NodeJS.ReadableStream | Readable,
  options?: SarifStreamOptions,
): AsyncGenerator<SarifResult, void, unknown> {
  const stream: NodeJS.ReadableStream =
    typeof source === "string"
      ? fs.createReadStream(source, {
          encoding: "utf-8",
          highWaterMark: options?.highWaterMark || 64 * 1024,
        })
      : source;

  if ("setEncoding" in stream && typeof stream.setEncoding === "function") {
    stream.setEncoding("utf-8");
  }

  // Parser state
  enum State {
    SEARCHING_RESULTS,
    WAITING_ARRAY_OPEN,
    IN_RESULTS_ARRAY,
  }

  let state = State.SEARCHING_RESULTS;
  let inString = false;
  let isEscaped = false;
  let braceDepth = 0;
  let currentObjectStr = "";
  let searchWindow = "";

  for await (const chunk of stream) {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (state === State.SEARCHING_RESULTS) {
        if (inString) {
          if (isEscaped) {
            isEscaped = false;
          } else if (char === "\\") {
            isEscaped = true;
          } else if (char === '"') {
            inString = false;
            if (searchWindow === "results") {
              state = State.WAITING_ARRAY_OPEN;
            }
            searchWindow = "";
          } else {
            searchWindow += char;
          }
        } else {
          if (char === '"') {
            inString = true;
            searchWindow = "";
            isEscaped = false;
          }
        }
      } else if (state === State.WAITING_ARRAY_OPEN) {
        if (char === "[") {
          state = State.IN_RESULTS_ARRAY;
          braceDepth = 0;
          currentObjectStr = "";
          inString = false;
          isEscaped = false;
        } else if (!/\s|:/.test(char)) {
          // If unexpected non-whitespace token appears before '[', resume search
          state = State.SEARCHING_RESULTS;
          searchWindow = "";
        }
      } else if (state === State.IN_RESULTS_ARRAY) {
        if (braceDepth === 0) {
          if (char === "{") {
            braceDepth = 1;
            currentObjectStr = "{";
            inString = false;
            isEscaped = false;
          } else if (char === "]") {
            // End of current results array
            state = State.SEARCHING_RESULTS;
          }
        } else {
          // Inside a single result object
          currentObjectStr += char;

          if (inString) {
            if (isEscaped) {
              isEscaped = false;
            } else if (char === "\\") {
              isEscaped = true;
            } else if (char === '"') {
              inString = false;
            }
          } else {
            if (char === '"') {
              inString = true;
              isEscaped = false;
            } else if (char === "{") {
              braceDepth++;
            } else if (char === "}") {
              braceDepth--;
              if (braceDepth === 0) {
                // Completed one complete SarifResult object
                try {
                  const result = JSON.parse(currentObjectStr) as SarifResult;
                  yield result;
                } catch {
                  // In case of malformed chunk, continue gracefully
                }
                currentObjectStr = "";
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Processes a SARIF report using streaming and invokes a callback for each result.
 */
export async function parseSarifStream(
  source: string | NodeJS.ReadableStream | Readable,
  onResult: (result: SarifResult) => void | Promise<void>,
  options?: SarifStreamOptions,
): Promise<{ totalResults: number }> {
  let totalResults = 0;
  for await (const result of streamSarifResults(source, options)) {
    await onResult(result);
    totalResults++;
  }
  return { totalResults };
}

/**
 * Streaming parser that reads a SARIF file from disk with fs.createReadStream.
 */
export async function parseSarifFileStream(
  filePath: string,
  onResult?: (result: SarifResult) => void | Promise<void>,
  options?: SarifStreamOptions,
): Promise<{ results: SarifResult[]; totalResults: number }> {
  const results: SarifResult[] = [];
  let totalResults = 0;

  for await (const result of streamSarifResults(filePath, options)) {
    if (onResult) {
      await onResult(result);
    } else {
      results.push(result);
    }
    totalResults++;
  }

  return { results, totalResults };
}

