/**
 * SARIF (Static Analysis Results Interchange Format) Exporter for SecureFlow CLI (#728)
 *
 * Converts CLI scan results into standardized OASIS SARIF v2.1.0 schema format
 * for direct ingestion by GitHub Advanced Security, GitLab Security Dashboards, and enterprise CI/CD systems.
 */

// Added `type` prefix for verbatimModuleSyntax compliance
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
                if (
                  !rule.shortDescription ||
                  typeof rule.shortDescription !== "object" ||
                  typeof (rule.shortDescription as Record<string, unknown>).text !== "string" ||
                  !(rule.shortDescription as Record<string, unknown>).text.trim()
                ) {
                  errors.push(`${rulePath}.shortDescription.text must be a non-empty string`);
                }
                if (rule.defaultConfiguration !== undefined) {
                  if (
                    typeof rule.defaultConfiguration !== "object" ||
                    !rule.defaultConfiguration
                  ) {
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
          ? (((run.tool as Record<string, unknown>).driver as Record<string, unknown>)
              ?.rules as Array<Record<string, unknown>> | undefined)
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
            errors.push(
              `${resPath}.level must be one of 'error' | 'warning' | 'note' | 'none'`,
            );
          }
          if (
            !res.message ||
            typeof res.message !== "object" ||
            typeof (res.message as Record<string, unknown>).text !== "string" ||
            !(res.message as Record<string, unknown>).text.trim()
          ) {
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
              } else if (
                driverRules[res.ruleIndex] &&
                driverRules[res.ruleIndex].id !== res.ruleId
              ) {
                errors.push(
                  `${resPath}.ruleIndex (${res.ruleIndex}) points to rule id '${driverRules[res.ruleIndex].id}' which does not match result ruleId '${res.ruleId}'`,
                );
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
                if (
                  !phys.artifactLocation ||
                  typeof phys.artifactLocation !== "object" ||
                  typeof (phys.artifactLocation as Record<string, unknown>).uri !== "string" ||
                  !(phys.artifactLocation as Record<string, unknown>).uri.trim()
                ) {
                  errors.push(
                    `${locPath}.physicalLocation.artifactLocation.uri must be a non-empty string`,
                  );
                } else if (
                  ((phys.artifactLocation as Record<string, unknown>).uri as string).includes(
                    "\\",
                  )
                ) {
                  errors.push(
                    `${locPath}.physicalLocation.artifactLocation.uri must use forward slashes (no Windows backslashes)`,
                  );
                }

                if (
                  !phys.region ||
                  typeof phys.region !== "object" ||
                  Array.isArray(phys.region)
                ) {
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
 * Maps CLI scan results into a valid OASIS SARIF v2.1.0 document object.
 * Validates the schema before returning.
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
  options?: { toolVersion?: string },
): string {
  const sarifDoc = generateSarifReport(scanResults, options);
  return JSON.stringify(sarifDoc, null, 2);
}
