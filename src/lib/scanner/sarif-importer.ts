import { createHash } from "crypto";

/**
 * Deterministic SARIF 2.1.0 Importer & Rule-Severity Normalizer (#2204).
 *
 * Ingests SARIF 2.1.0 JSON logs from third-party static analysis tools
 * (Semgrep, CodeQL, Trivy, Gitleaks, etc.) into SecureFlow's normalized finding model.
 */

export type NormalizedSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type SarifLevel = "error" | "warning" | "note" | "none";

export interface SarifRuleDescriptor {
  id: string;
  name?: string;
  shortDescription?: { text?: string };
  fullDescription?: { text?: string };
  helpUri?: string;
  defaultConfiguration?: { level?: SarifLevel };
  properties?: {
    tags?: string[];
    "security-severity"?: string | number;
    [key: string]: unknown;
  };
}

export interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string; uriBaseId?: string };
  region?: { startLine?: number; endLine?: number; startColumn?: number; endColumn?: number };
}

export interface SarifResult {
  ruleId?: string;
  ruleIndex?: number;
  level?: SarifLevel;
  message?: { text?: string; markdown?: string };
  locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>;
  partialFingerprints?: Record<string, string>;
  fingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

export interface SarifRun {
  tool?: {
    driver?: {
      name?: string;
      version?: string;
      informationUri?: string;
      rules?: SarifRuleDescriptor[];
    };
  };
  results?: SarifResult[];
}

export interface SarifLogDocument {
  $schema?: string;
  version?: string;
  runs?: SarifRun[];
}

export interface NormalizedSarifFinding {
  ruleId: string;
  type: string;
  severity: NormalizedSeverity;
  level: SarifLevel;
  title: string;
  description: string;
  fileLocation: string;
  lineStart: number;
  lineEnd: number;
  cwe?: string;
  cweTags: string[];
  helpUri?: string;
  fingerprint: string;
  toolName: string;
  sourceTools: string[];
}

export interface SarifImportResult {
  valid: boolean;
  errors: string[];
  findings: NormalizedSarifFinding[];
  toolDrivers: Array<{ name: string; version?: string; resultCount: number }>;
  deduplicatedCount: number;
}

function normalizeUri(uri?: string): string {
  if (!uri) return "unknown";
  return uri
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function extractCweTags(tags?: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  const cwes = new Set<string>();
  for (const tag of tags) {
    const match = String(tag).match(/cwe-(\d+)/i);
    if (match) {
      cwes.add(`CWE-${match[1]}`);
    }
  }
  return [...cwes];
}

/**
 * Normalize SARIF level and optional CVSS security-severity score into SecureFlow severity.
 */
export function normalizeSarifSeverity(
  level?: string,
  securitySeverity?: string | number,
): NormalizedSeverity {
  if (securitySeverity !== undefined && securitySeverity !== null) {
    const score =
      typeof securitySeverity === "number" ? securitySeverity : parseFloat(securitySeverity);
    if (!isNaN(score) && isFinite(score)) {
      if (score >= 9.0) return "CRITICAL";
      if (score >= 7.0) return "HIGH";
      if (score >= 4.0) return "MEDIUM";
      if (score > 0) return "LOW";
      return "INFO";
    }
  }

  switch ((level ?? "warning").toLowerCase()) {
    case "error":
      return "HIGH";
    case "warning":
      return "MEDIUM";
    case "note":
      return "LOW";
    case "none":
      return "INFO";
    default:
      return "MEDIUM";
  }
}

function buildDeterministicFingerprint(
  ruleId: string,
  fileLocation: string,
  lineStart: number,
  message: string,
  partialFingerprints?: Record<string, string>,
  fingerprints?: Record<string, string>,
): string {
  const existing =
    fingerprints?.primaryLocationLineHash ??
    partialFingerprints?.primaryLocationLineHash ??
    Object.values(fingerprints ?? {})[0] ??
    Object.values(partialFingerprints ?? {})[0];

  if (existing && typeof existing === "string" && existing.trim().length > 0) {
    return existing.trim();
  }

  return createHash("sha256")
    .update(`${ruleId}|${fileLocation}|${lineStart}|${message}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Parse and normalize a SARIF 2.1.0 document (JSON string or object).
 */
export function parseSarifLog(input: string | SarifLogDocument): SarifImportResult {
  let doc: SarifLogDocument;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input) as SarifLogDocument;
    } catch (err) {
      return {
        valid: false,
        errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
        findings: [],
        toolDrivers: [],
        deduplicatedCount: 0,
      };
    }
  } else if (input && typeof input === "object") {
    doc = input;
  } else {
    return {
      valid: false,
      errors: ["SARIF input must be a JSON string or object"],
      findings: [],
      toolDrivers: [],
      deduplicatedCount: 0,
    };
  }

  const errors: string[] = [];
  if (doc.version !== "2.1.0") {
    errors.push(`Unsupported or missing SARIF version "${String(doc.version)}"; expected "2.1.0"`);
  }
  if (!Array.isArray(doc.runs)) {
    errors.push("Missing required 'runs' array in SARIF document");
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      findings: [],
      toolDrivers: [],
      deduplicatedCount: 0,
    };
  }

  const toolDrivers: Array<{ name: string; version?: string; resultCount: number }> = [];
  const findingsByKey = new Map<string, NormalizedSarifFinding>();
  let deduplicatedCount = 0;

  for (const run of doc.runs ?? []) {
    const driver = run.tool?.driver;
    const toolName = driver?.name?.trim() || "unknown-scanner";
    const rules = driver?.rules ?? [];
    const ruleById = new Map<string, SarifRuleDescriptor>();
    for (const rule of rules) {
      if (rule.id) {
        ruleById.set(rule.id, rule);
      }
    }

    const results = Array.isArray(run.results) ? run.results : [];
    toolDrivers.push({
      name: toolName,
      version: driver?.version,
      resultCount: results.length,
    });

    for (const result of results) {
      const ruleFromIndex =
        typeof result.ruleIndex === "number" ? rules[result.ruleIndex] : undefined;
      const ruleId = result.ruleId || ruleFromIndex?.id || "UNKNOWN_RULE";
      const ruleMeta = ruleById.get(ruleId) ?? ruleFromIndex;

      const level: SarifLevel = result.level ?? ruleMeta?.defaultConfiguration?.level ?? "warning";
      const securitySeverity =
        (result.properties?.["security-severity"] as string | number | undefined) ??
        ruleMeta?.properties?.["security-severity"];
      const severity = normalizeSarifSeverity(level, securitySeverity);

      const phys = result.locations?.[0]?.physicalLocation;
      const fileLocation = normalizeUri(phys?.artifactLocation?.uri);
      const lineStart = Math.max(1, phys?.region?.startLine ?? 1);
      const lineEnd = Math.max(lineStart, phys?.region?.endLine ?? lineStart);

      const message =
        result.message?.text?.trim() ||
        ruleMeta?.shortDescription?.text?.trim() ||
        `Finding reported by ${toolName} (${ruleId})`;

      const cweTags = extractCweTags(ruleMeta?.properties?.tags);
      const fingerprint = buildDeterministicFingerprint(
        ruleId,
        fileLocation,
        lineStart,
        message,
        result.partialFingerprints,
        result.fingerprints,
      );

      const dedupeKey = `${fingerprint}|${fileLocation}|${lineStart}|${ruleId}`;
      const existing = findingsByKey.get(dedupeKey);
      if (existing) {
        deduplicatedCount++;
        if (!existing.sourceTools.includes(toolName)) {
          existing.sourceTools.push(toolName);
        }
        continue;
      }

      findingsByKey.set(dedupeKey, {
        ruleId,
        type: cweTags[0] ?? ruleId,
        severity,
        level,
        title: ruleMeta?.shortDescription?.text?.trim() || ruleId,
        description: message,
        fileLocation,
        lineStart,
        lineEnd,
        cwe: cweTags[0],
        cweTags,
        helpUri: ruleMeta?.helpUri,
        fingerprint,
        toolName,
        sourceTools: [toolName],
      });
    }
  }

  return {
    valid: true,
    errors: [],
    findings: [...findingsByKey.values()],
    toolDrivers,
    deduplicatedCount,
  };
}

/**
 * Import SARIF 2.1.0 findings, throwing an Error if validation fails.
 */
export function importSarifFindings(input: string | SarifLogDocument): NormalizedSarifFinding[] {
  const result = parseSarifLog(input);
  if (!result.valid) {
    throw new Error(`SARIF import failed: ${result.errors.join("; ")}`);
  }
  return result.findings;
}
