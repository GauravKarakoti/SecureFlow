/**
 * SARIF (Static Analysis Results Interchange Format) Exporter for SecureFlow CLI (#728)
 *
 * Converts CLI scan results into standardized OASIS SARIF v2.1.0 schema format
 * for direct ingestion by GitHub Advanced Security, GitLab Security Dashboards, and enterprise CI/CD systems.
 */

// Added `type` prefix for verbatimModuleSyntax compliance
import fs from "node:fs";
import crypto from "node:crypto";
import type { Readable } from "node:stream";
import type { FileScanResult, Violation } from "./scanner.js";
import type { AiFinding } from "./lib/api-client.js";

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

export interface SarifReplacement {
  deletedRegion: {
    startLine: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  };
  insertedContent?: {
    text: string;
  };
}

export interface SarifArtifactChange {
  artifactLocation: SarifArtifactLocation;
  replacements: SarifReplacement[];
}

export interface SarifFix {
  description: {
    text: string;
  };
  artifactChanges: SarifArtifactChange[];
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
  partialFingerprints?: Record<string, string>;
  fixes?: SarifFix[];
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

const VALID_LEVELS = ["error", "warning", "note", "none"] as const;

export class SarifValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`SARIF schema validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "SarifValidationError";
    this.errors = errors;
  }
}

/**
 * Validates a document against the OASIS SARIF v2.1.0 specification and
 * external CI/CD ingestion requirements (such as GitHub Advanced Security).
 */
export function validateSarifDocument(doc: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { valid: false, errors: ["SARIF root must be a non-null object"] };
  }

  const root = doc as Record<string, unknown>;

  // Schema validation
  if (typeof root.$schema !== "string" || !root.$schema.trim()) {
    errors.push("SARIF '$schema' must be a non-empty URI string");
  } else if (!root.$schema.includes("sarif")) {
    errors.push(`SARIF '$schema' must reference a SARIF schema (got: '${root.$schema}')`);
  }

  // Version validation
  if (root.version !== "2.1.0") {
    errors.push(`SARIF 'version' must be '2.1.0' (got: '${String(root.version)}')`);
  }

  // Runs validation
  if (!Array.isArray(root.runs)) {
    errors.push("SARIF 'runs' must be an array");
  } else if (root.runs.length === 0) {
    errors.push("SARIF 'runs' must contain at least one run object");
  } else {
    root.runs.forEach((runItem: unknown, runIdx: number) => {
      const runPath = `runs[${runIdx}]`;
      if (!runItem || typeof runItem !== "object" || Array.isArray(runItem)) {
        errors.push(`${runPath} must be a non-null object`);
        return;
      }
      const run = runItem as Record<string, unknown>;

      // Tool validation
      if (!run.tool || typeof run.tool !== "object" || Array.isArray(run.tool)) {
        errors.push(`${runPath}.tool must be an object`);
      } else {
        const tool = run.tool as Record<string, unknown>;
        if (!tool.driver || typeof tool.driver !== "object" || Array.isArray(tool.driver)) {
          errors.push(`${runPath}.tool.driver must be an object`);
        } else {
          const driver = tool.driver as Record<string, unknown>;
          if (typeof driver.name !== "string" || !driver.name.trim()) {
            errors.push(`${runPath}.tool.driver.name must be a non-empty string`);
          }
          if (driver.semanticVersion !== undefined && typeof driver.semanticVersion !== "string") {
            errors.push(`${runPath}.tool.driver.semanticVersion must be a string if provided`);
          }
          if (
            driver.informationUri !== undefined &&
            (typeof driver.informationUri !== "string" || !driver.informationUri.trim())
          ) {
            errors.push(
              `${runPath}.tool.driver.informationUri must be a valid URI string if provided`,
            );
          }
          if (driver.rules !== undefined) {
            if (!Array.isArray(driver.rules)) {
              errors.push(`${runPath}.tool.driver.rules must be an array`);
            } else {
              driver.rules.forEach((ruleItem: unknown, ruleIdx: number) => {
                const rulePath = `${runPath}.tool.driver.rules[${ruleIdx}]`;
                if (!ruleItem || typeof ruleItem !== "object" || Array.isArray(ruleItem)) {
                  errors.push(`${rulePath} must be an object`);
                  return;
                }
                const rule = ruleItem as Record<string, unknown>;
                if (typeof rule.id !== "string" || !rule.id.trim()) {
                  errors.push(`${rulePath}.id must be a non-empty string`);
                }
                if (rule.name !== undefined && typeof rule.name !== "string") {
                  errors.push(`${rulePath}.name must be a string`);
                }

                // Read the property once: casting twice makes the second read a
                // fresh expression, so the typeof narrowing does not reach .trim().
                const shortDescriptionText = (
                  rule.shortDescription as Record<string, unknown> | undefined
                )?.text;
                if (typeof shortDescriptionText !== "string" || !shortDescriptionText.trim()) {
                  errors.push(`${rulePath}.shortDescription.text must be a non-empty string`);
                }
                if (rule.defaultConfiguration !== undefined) {
                  if (typeof rule.defaultConfiguration !== "object" || !rule.defaultConfiguration) {
                    errors.push(`${rulePath}.defaultConfiguration must be an object`);
                  } else {
                    const config = rule.defaultConfiguration as Record<string, unknown>;
                    if (
                      config.level !== undefined &&
                      !VALID_LEVELS.includes(config.level as (typeof VALID_LEVELS)[number])
                    ) {
                      errors.push(
                        `${rulePath}.defaultConfiguration.level must be one of 'error' | 'warning' | 'note' | 'none'`,
                      );
                    }
                  }
                }
              });
            }
          }
        }
      }

      // Results validation
      if (!Array.isArray(run.results)) {
        errors.push(`${runPath}.results must be an array`);
      } else {
        const driverRules = (run.tool as Record<string, unknown> | undefined)?.driver
          ? (((run.tool as Record<string, unknown>).driver as Record<string, unknown>)?.rules as
              Array<Record<string, unknown>> | undefined)
          : undefined;

        run.results.forEach((resItem: unknown, resIdx: number) => {
          const resPath = `${runPath}.results[${resIdx}]`;
          if (!resItem || typeof resItem !== "object" || Array.isArray(resItem)) {
            errors.push(`${resPath} must be an object`);
            return;
          }
          const res = resItem as Record<string, unknown>;
          if (typeof res.ruleId !== "string" || !res.ruleId.trim()) {
            errors.push(`${resPath}.ruleId must be a non-empty string`);
          }
          if (
            res.level !== undefined &&
            !VALID_LEVELS.includes(res.level as (typeof VALID_LEVELS)[number])
          ) {
            errors.push(`${resPath}.level must be one of 'error' | 'warning' | 'note' | 'none'`);
          }

          const messageText = (res.message as Record<string, unknown> | undefined)?.text;
          if (typeof messageText !== "string" || !messageText.trim()) {
            errors.push(`${resPath}.message.text must be a non-empty string`);
          }

          if (res.ruleIndex !== undefined) {
            if (
              typeof res.ruleIndex !== "number" ||
              !Number.isInteger(res.ruleIndex) ||
              res.ruleIndex < 0
            ) {
              errors.push(`${resPath}.ruleIndex must be a non-negative integer`);
            } else if (Array.isArray(driverRules)) {
              if (res.ruleIndex >= driverRules.length) {
                errors.push(
                  `${resPath}.ruleIndex (${res.ruleIndex}) is out of bounds for rules array of length ${driverRules.length}`,
                );
              } else {
                // Bound once: under noUncheckedIndexedAccess every re-index is a
                // separate possibly-undefined read.
                const referencedRule = driverRules[res.ruleIndex];
                if (referencedRule && referencedRule.id !== res.ruleId) {
                  errors.push(
                    `${resPath}.ruleIndex (${res.ruleIndex}) points to rule id '${String(referencedRule.id)}' which does not match result ruleId '${res.ruleId}'`,
                  );
                }
              }
            }
          }

          if (res.locations !== undefined) {
            if (!Array.isArray(res.locations)) {
              errors.push(`${resPath}.locations must be an array`);
            } else {
              res.locations.forEach((locItem: unknown, locIdx: number) => {
                const locPath = `${resPath}.locations[${locIdx}]`;
                if (!locItem || typeof locItem !== "object" || Array.isArray(locItem)) {
                  errors.push(`${locPath} must be an object`);
                  return;
                }
                const loc = locItem as Record<string, unknown>;
                if (
                  !loc.physicalLocation ||
                  typeof loc.physicalLocation !== "object" ||
                  Array.isArray(loc.physicalLocation)
                ) {
                  errors.push(`${locPath}.physicalLocation must be an object`);
                  return;
                }
                const phys = loc.physicalLocation as Record<string, unknown>;
                const artifactUri = (phys.artifactLocation as Record<string, unknown> | undefined)
                  ?.uri;

                if (typeof artifactUri !== "string" || !artifactUri.trim()) {
                  errors.push(
                    `${locPath}.physicalLocation.artifactLocation.uri must be a non-empty string`,
                  );
                } else if (artifactUri.includes("\\")) {
                  errors.push(
                    `${locPath}.physicalLocation.artifactLocation.uri must use forward slashes (no Windows backslashes)`,
                  );
                }

                if (!phys.region || typeof phys.region !== "object" || Array.isArray(phys.region)) {
                  errors.push(`${locPath}.physicalLocation.region must be an object`);
                } else {
                  const reg = phys.region as Record<string, unknown>;
                  if (
                    typeof reg.startLine !== "number" ||
                    !Number.isInteger(reg.startLine) ||
                    reg.startLine < 1
                  ) {
                    errors.push(
                      `${locPath}.physicalLocation.region.startLine must be an integer >= 1`,
                    );
                  }
                  if (
                    reg.startColumn !== undefined &&
                    (typeof reg.startColumn !== "number" ||
                      !Number.isInteger(reg.startColumn) ||
                      reg.startColumn < 1)
                  ) {
                    errors.push(
                      `${locPath}.physicalLocation.region.startColumn must be an integer >= 1`,
                    );
                  }
                  if (
                    reg.endLine !== undefined &&
                    (typeof reg.endLine !== "number" ||
                      !Number.isInteger(reg.endLine) ||
                      reg.endLine < (typeof reg.startLine === "number" ? reg.startLine : 1))
                  ) {
                    errors.push(
                      `${locPath}.physicalLocation.region.endLine must be an integer >= startLine`,
                    );
                  }
                  if (
                    reg.endColumn !== undefined &&
                    (typeof reg.endColumn !== "number" ||
                      !Number.isInteger(reg.endColumn) ||
                      reg.endColumn < 1)
                  ) {
                    errors.push(
                      `${locPath}.physicalLocation.region.endColumn must be an integer >= 1`,
                    );
                  }
                }
              });
            }
          }

          // Partial Fingerprints validation (#1754)
          if (res.partialFingerprints !== undefined) {
            if (
              typeof res.partialFingerprints !== "object" ||
              res.partialFingerprints === null ||
              Array.isArray(res.partialFingerprints)
            ) {
              errors.push(`${resPath}.partialFingerprints must be an object`);
            } else {
              for (const [fpKey, fpVal] of Object.entries(
                res.partialFingerprints as Record<string, unknown>,
              )) {
                if (typeof fpVal !== "string" || !fpVal.trim()) {
                  errors.push(
                    `${resPath}.partialFingerprints["${fpKey}"] must be a non-empty string`,
                  );
                }
              }
            }
          }

          // Fixes / Replacement Hunks validation (#1754)
          if (res.fixes !== undefined) {
            if (!Array.isArray(res.fixes)) {
              errors.push(`${resPath}.fixes must be an array`);
            } else {
              res.fixes.forEach((fixItem: unknown, fixIdx: number) => {
                const fixPath = `${resPath}.fixes[${fixIdx}]`;
                if (!fixItem || typeof fixItem !== "object" || Array.isArray(fixItem)) {
                  errors.push(`${fixPath} must be an object`);
                  return;
                }
                const fix = fixItem as Record<string, unknown>;
                const fixDesc = (fix.description as Record<string, unknown> | undefined)?.text;
                if (typeof fixDesc !== "string" || !fixDesc.trim()) {
                  errors.push(`${fixPath}.description.text must be a non-empty string`);
                }

                if (!Array.isArray(fix.artifactChanges)) {
                  errors.push(`${fixPath}.artifactChanges must be an array`);
                } else {
                  fix.artifactChanges.forEach((changeItem: unknown, changeIdx: number) => {
                    const changePath = `${fixPath}.artifactChanges[${changeIdx}]`;
                    if (
                      !changeItem ||
                      typeof changeItem !== "object" ||
                      Array.isArray(changeItem)
                    ) {
                      errors.push(`${changePath} must be an object`);
                      return;
                    }
                    const change = changeItem as Record<string, unknown>;
                    const changeUri = (
                      change.artifactLocation as Record<string, unknown> | undefined
                    )?.uri;
                    if (typeof changeUri !== "string" || !changeUri.trim()) {
                      errors.push(`${changePath}.artifactLocation.uri must be a non-empty string`);
                    }

                    if (!Array.isArray(change.replacements)) {
                      errors.push(`${changePath}.replacements must be an array`);
                    } else {
                      change.replacements.forEach((repItem: unknown, repIdx: number) => {
                        const repPath = `${changePath}.replacements[${repIdx}]`;
                        if (!repItem || typeof repItem !== "object" || Array.isArray(repItem)) {
                          errors.push(`${repPath} must be an object`);
                          return;
                        }
                        const rep = repItem as Record<string, unknown>;
                        if (!rep.deletedRegion || typeof rep.deletedRegion !== "object") {
                          errors.push(`${repPath}.deletedRegion must be an object`);
                        } else {
                          const del = rep.deletedRegion as Record<string, unknown>;
                          if (
                            typeof del.startLine !== "number" ||
                            !Number.isInteger(del.startLine) ||
                            del.startLine < 1
                          ) {
                            errors.push(
                              `${repPath}.deletedRegion.startLine must be an integer >= 1`,
                            );
                          }
                        }
                      });
                    }
                  });
                }
              });
            }
          }
        });
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Asserts that a document is a valid SARIF document, throwing a SarifValidationError if invalid.
 */
export function assertValidSarifDocument(doc: unknown): asserts doc is SarifDocument {
  const result = validateSarifDocument(doc);
  if (!result.valid) {
    throw new SarifValidationError(result.errors);
  }
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
 * Normalizes source text snippet to compute deterministic fingerprint across line shifts (#1754).
 */
export function computeSnippetFingerprint(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Builds standard SARIF v2.1.0 fix hunks from remediation text/diff (#1754).
 */
export function buildSarifFix(
  filePath: string,
  startLine: number,
  replacementText?: string,
  endLine?: number,
): SarifFix | undefined {
  if (!replacementText || !replacementText.trim()) {
    return undefined;
  }
  const uri = filePath.replace(/\\/g, "/");
  return {
    description: {
      text: "Automated remediation patch for security violation",
    },
    artifactChanges: [
      {
        artifactLocation: { uri },
        replacements: [
          {
            deletedRegion: {
              startLine: Math.max(1, startLine),
              ...(endLine && endLine >= startLine ? { endLine } : {}),
            },
            insertedContent: {
              text: replacementText,
            },
          },
        ],
      },
    ],
  };
}

/**
 * Converts finding severity into SARIF level ("error" | "warning" | "note") (#1766).
 */
export function severityToSarifLevel(severity?: string): "error" | "warning" | "note" {
  switch (severity?.toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return "error";
    case "MEDIUM":
      return "warning";
    case "LOW":
    case "INFO":
    default:
      return "note";
  }
}

/**
 * Maps CLI scan results into a valid OASIS SARIF v2.1.0 document object.
 * Validates the schema before returning.
 */
export function generateSarifReport(
  scanResults: FileScanResult[],
  options?: {
    toolVersion?: string;
    repoUri?: string;
    remediations?: Record<string, string>;
    aiFindings?: AiFinding[];
  },
): SarifDocument {
  const version = options?.toolVersion || "0.1.0";
  const rulesMap = new Map<string, { descriptor: SarifReportingDescriptor; index: number }>();
  const sarifResults: SarifResult[] = [];

  for (const fileResult of scanResults) {
    if (!fileResult.violations || fileResult.violations.length === 0) {
      continue;
    }

    const normalizedPath = fileResult.path.replace(/\\/g, "/");

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
            level: severityToSarifLevel(violation.severity),
          },
          helpUri: "https://github.com/GauravKarakoti/SecureFlow#rules",
        };

        ruleInfo = { descriptor, index: rulesMap.size };
        rulesMap.set(reasonKey, ruleInfo);
      }

      const fingerprint = computeSnippetFingerprint(violation.text);
      const fixKey = `${normalizedPath}:${violation.line}`;
      const replacement = options?.remediations?.[fixKey] || options?.remediations?.[fingerprint];
      const fix = buildSarifFix(normalizedPath, violation.line, replacement);

      sarifResults.push({
        ruleId: ruleInfo.descriptor.id,
        ruleIndex: ruleInfo.index,
        level: violation.severity
          ? severityToSarifLevel(violation.severity)
          : ruleInfo.descriptor.defaultConfiguration?.level || "error",
        message: {
          text: `[SecureFlow] ${violation.reason} passed to console call: "${violation.text}"`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: normalizedPath,
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
        partialFingerprints: {
          "checksum/v1": fingerprint,
          primaryLocationLineHash: fingerprint,
        },
        ...(fix ? { fixes: [fix] } : {}),
        properties: {
          reason: violation.reason,
          severity: violation.severity || "HIGH",
        },
      });
    }
  }

  // Include AI-detected findings in the SARIF report (#1766)
  if (options?.aiFindings && options.aiFindings.length > 0) {
    for (const aiFinding of options.aiFindings) {
      const ruleKey = `AI-${aiFinding.type}`;
      let ruleInfo = rulesMap.get(ruleKey);

      if (!ruleInfo) {
        const descriptor: SarifReportingDescriptor = {
          id: `SECUREFLOW-AI-${rulesMap.size + 100}`,
          name: aiFinding.type.replace(/[^A-Za-z0-9]/g, ""),
          shortDescription: {
            text: aiFinding.description,
          },
          fullDescription: {
            text: `AI-detected vulnerability of type ${aiFinding.type}: ${aiFinding.description}`,
          },
          defaultConfiguration: {
            level: severityToSarifLevel(aiFinding.severity),
          },
          helpUri: "https://github.com/GauravKarakoti/SecureFlow#rules",
        };

        ruleInfo = { descriptor, index: rulesMap.size };
        rulesMap.set(ruleKey, ruleInfo);
      }

      const normUri = aiFinding.fileLocation.replace(/\\/g, "/");
      const line = aiFinding.lineStart && aiFinding.lineStart > 0 ? aiFinding.lineStart : 1;
      const snippet = aiFinding.codeSnippet || aiFinding.description;
      const fingerprint = aiFinding.dynamicFingerprint || computeSnippetFingerprint(snippet);

      sarifResults.push({
        ruleId: ruleInfo.descriptor.id,
        ruleIndex: ruleInfo.index,
        level: severityToSarifLevel(aiFinding.severity),
        message: {
          text: `[SecureFlow AI] ${aiFinding.description}`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: normUri,
              },
              region: {
                startLine: line,
                ...(aiFinding.lineEnd && aiFinding.lineEnd >= line
                  ? { endLine: aiFinding.lineEnd }
                  : {}),
                snippet: {
                  text: snippet,
                },
              },
            },
          },
        ],
        partialFingerprints: {
          "checksum/v1": fingerprint,
          primaryLocationLineHash: fingerprint,
        },
        properties: {
          type: aiFinding.type,
          severity: aiFinding.severity,
          isZeroDay: aiFinding.isZeroDay,
        },
      });
    }
  }

  const rulesArray = Array.from(rulesMap.values()).map((r) => r.descriptor);
  if (rulesArray.length === 0) {
    // Appended `!` to override 'undefined' error resulting from Record<string, ...> signature
    rulesArray.push(DEFAULT_RULE_DEFINITIONS["generic-secret-logging"]!);
  }

  const sarifDoc: SarifDocument = {
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

  assertValidSarifDocument(sarifDoc);

  return sarifDoc;
}

/**
 * Format SARIF report as pretty JSON string.
 */
export function formatSarifJson(
  scanResults: FileScanResult[],
  options?: {
    toolVersion?: string;
    repoUri?: string;
    remediations?: Record<string, string>;
    aiFindings?: AiFinding[];
  },
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
      const char = str.charAt(i);

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
          } else if (searchWindow.length < "results".length) {
            // Only the "results" comparison matters, so cap the window:
            // accumulating every char of a large string value before the
            // results key (e.g. a big fullDescription) was O(n²) and broke
            // the flat-memory guarantee this parser exists for.
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
