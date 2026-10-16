/**
 * Compliance-Enhanced SARIF 2.1.0 Exporter
 *
 * Emits SARIF documents with enriched regulatory compliance criteria
 * (OWASP, SOC 2, PCI-DSS, HIPAA, ISO 27001) attached to rule tags and results.
 */


export type SarifLevel = "error" | "warning" | "note";

export interface ComplianceSarifFinding {
  id?: string;
  type?: unknown;
  severity?: unknown;
  fileLocation?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  explanation?: string | null;
  remediation?: string | null;
  codeSnippet?: string | null;
  fingerprint?: string | null;
  complianceTags?: string[];
  cwe?: string | string[];
}

export interface ComplianceSarifDocument {
  $schema: "https://json.schemastore.org/sarif-2.1.0.json";
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
          fullDescription: { text: string };
          defaultConfiguration: { level: SarifLevel };
          help?: { text: string; markdown?: string };
          properties: {
            tags: string[];
            "security-severity": string;
            complianceTags: string[];
          };
          helpUri: string;
        }>;
        taxa?: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: SarifLevel;
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number; endLine?: number };
        };
      }>;
      properties?: {
        complianceTags: string[];
        remediation?: string;
      };
      partialFingerprints?: Record<string, string>;
    }>;
  }>;
}

const LEVEL_MAP: Record<StoredSeverity, SarifLevel> = {
  CRITICAL: "error",
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "note",
  INFO: "note",
};

const CVSS_SEVERITY: Record<StoredSeverity, string> = {
  CRITICAL: "9.0",
  HIGH: "7.5",
  MEDIUM: "5.0",
  LOW: "2.5",
  INFO: "0.0",
};

/**
 * Builds a complete compliance-enhanced SARIF 2.1.0 document from scan findings.
 */
export function buildComplianceSarifDocument(
  findings: readonly ComplianceSarifFinding[],
  options?: { toolName?: string; toolVersion?: string; informationUri?: string },
): ComplianceSarifDocument {
  const toolName = options?.toolName || "SecureFlow";
  const toolVersion = options?.toolVersion || "0.1.0";
  const informationUri = options?.informationUri || "https://github.com/GauravKarakoti/SecureFlow";

  const ruleMap = new Map<string, number>();
  const rules: ComplianceSarifDocument["runs"][0]["tool"]["driver"]["rules"] = [];
  const results: ComplianceSarifDocument["runs"][0]["results"] = [];

  for (const finding of findings) {
    const category = normalizeFindingType(finding.type);
    const severity = toStoredSeverity(finding.severity);
    const complianceTags = finding.complianceTags && finding.complianceTags.length > 0
      ? finding.complianceTags
      : mapFindingToComplianceTags(finding);

    const ruleId = `SECUREFLOW-${category}-${severity}`;

    let ruleIndex = ruleMap.get(ruleId);
    if (ruleIndex === undefined) {
      ruleIndex = rules.length;
      ruleMap.set(ruleId, ruleIndex);

      const title = FINDING_CATEGORY_TITLE[category];
      const tags = ["security", category.toLowerCase(), ...complianceTags];

      rules.push({
        id: ruleId,
        name: `${title} (${severity})`,
        shortDescription: {
          text: `SecureFlow detected a ${severity.toLowerCase()} ${category.toLowerCase()} finding.`,
        },
        fullDescription: {
          text: `Identified security flaw mapped to compliance frameworks: ${complianceTags.join(", ") || "General Security"}.`,
        },
        defaultConfiguration: {
          level: LEVEL_MAP[severity],
        },
        help: {
          text: finding.remediation || "Review and remediate this finding according to company security guidelines.",
          markdown: finding.remediation ? `### Remediation Guidance\n\n${finding.remediation}` : undefined,
        },
        properties: {
          tags,
          "security-severity": CVSS_SEVERITY[severity],
          complianceTags,
        },
        helpUri: `${informationUri}#${ruleId.toLowerCase()}`,
      });
    }

    const uri = finding.fileLocation?.trim() || "unknown";
    const lineStart = finding.lineStart && finding.lineStart > 0 ? finding.lineStart : 1;
    const lineEnd = finding.lineEnd && finding.lineEnd >= lineStart ? finding.lineEnd : undefined;

    const messageText = finding.explanation?.trim() || `Potential ${category} vulnerability identified at ${uri}:${lineStart}`;

    results.push({
      ruleId,
      ruleIndex,
      level: LEVEL_MAP[severity],
      message: { text: messageText },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: {
              startLine: lineStart,
              ...(lineEnd ? { endLine: lineEnd } : {}),
            },
          },
        },
      ],
      properties: {
        complianceTags,
        remediation: finding.remediation || undefined,
      },
      partialFingerprints: finding.fingerprint
        ? { "secureflow/finding/v1": finding.fingerprint }
        : undefined,
    });
  }

  // Sort results by severity descending
  results.sort((a, b) => {
    const sevA = rules[a.ruleIndex]?.properties["security-severity"] || "0";
    const sevB = rules[b.ruleIndex]?.properties["security-severity"] || "0";
    return parseFloat(sevB) - parseFloat(sevA);
  });

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: toolVersion,
            informationUri,
            rules,
          },
        },
        results,
      },
    ],
  };
}
