/**
 * SARIF (Static Analysis Results Interchange Format) Exporter for SecureFlow CLI (#728)
 *
 * Converts CLI scan results into standardized OASIS SARIF v2.1.0 schema format
 * for direct ingestion by GitHub Advanced Security, GitLab Security Dashboards, and enterprise CI/CD systems.
 */

import { FileScanResult, Violation } from './scanner.js';

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
    level: 'error' | 'warning' | 'note' | 'none';
  };
  helpUri?: string;
  properties?: Record<string, unknown>;
}

export interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level: 'error' | 'warning' | 'note' | 'none';
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
  version: '2.1.0';
  runs: SarifRun[];
}

const DEFAULT_RULE_DEFINITIONS: Record<string, SarifReportingDescriptor> = {
  'environment variable': {
    id: 'SECUREFLOW-001',
    name: 'ConsoleSecretLoggingEnvironmentVariable',
    shortDescription: {
      text: 'Console logging of environment variable containing potential secret',
    },
    fullDescription: {
      text: 'Passing process.env or other environment variable getters into console methods exposes credentials in build logs or standard output.',
    },
    defaultConfiguration: {
      level: 'error',
    },
    helpUri: 'https://github.com/GauravKarakoti/SecureFlow#rules',
  },
  'secret-named identifier': {
    id: 'SECUREFLOW-002',
    name: 'ConsoleSecretLoggingSecretIdentifier',
    shortDescription: {
      text: 'Console logging of secret-named identifier or credential parameter',
    },
    fullDescription: {
      text: 'Identifiers containing secret, password, apikey, token, or auth parameters passed directly into console logging statements.',
    },
    defaultConfiguration: {
      level: 'error',
    },
    helpUri: 'https://github.com/GauravKarakoti/SecureFlow#rules',
  },
  'generic-secret-logging': {
    id: 'SECUREFLOW-000',
    name: 'ConsoleSecretLoggingGeneric',
    shortDescription: {
      text: 'Potential secret credential logging in console output',
    },
    defaultConfiguration: {
      level: 'error',
    },
    helpUri: 'https://github.com/GauravKarakoti/SecureFlow#rules',
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
  }
): SarifDocument {
  const version = options?.toolVersion || '0.1.0';
  const rulesMap = new Map<string, { descriptor: SarifReportingDescriptor; index: number }>();
  const sarifResults: SarifResult[] = [];

  for (const fileResult of scanResults) {
    if (!fileResult.violations || fileResult.violations.length === 0) {
      continue;
    }

    for (const violation of fileResult.violations) {
      const reasonKey = violation.reason || 'generic-secret-logging';
      let ruleInfo = rulesMap.get(reasonKey);

      if (!ruleInfo) {
        const descriptor = DEFAULT_RULE_DEFINITIONS[reasonKey] || {
          id: `SECUREFLOW-${rulesMap.size + 100}`,
          name: `ConsoleSecretLoggingCustomRule${rulesMap.size + 1}`,
          shortDescription: {
            text: `Console logging of ${violation.reason}`,
          },
          defaultConfiguration: {
            level: 'error',
          },
          helpUri: 'https://github.com/GauravKarakoti/SecureFlow#rules',
        };

        ruleInfo = { descriptor, index: rulesMap.size };
        rulesMap.set(reasonKey, ruleInfo);
      }

      sarifResults.push({
        ruleId: ruleInfo.descriptor.id,
        ruleIndex: ruleInfo.index,
        level: ruleInfo.descriptor.defaultConfiguration?.level || 'error',
        message: {
          text: `[SecureFlow] ${violation.reason} passed to console call: "${violation.text}"`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: fileResult.path.replace(/\\/g, '/'),
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
    rulesArray.push(DEFAULT_RULE_DEFINITIONS['generic-secret-logging']);
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'SecureFlow CLI',
            semanticVersion: version,
            informationUri: 'https://github.com/GauravKarakoti/SecureFlow',
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
export function formatSarifJson(scanResults: FileScanResult[], options?: { toolVersion?: string }): string {
  const sarifDoc = generateSarifReport(scanResults, options);
  return JSON.stringify(sarifDoc, null, 2);
}
