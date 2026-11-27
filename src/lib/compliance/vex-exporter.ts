import { createHash } from "crypto";
import type { AuditorComplianceDossier } from "./auditor-exporter";

/**
 * OpenVEX v0.2.0 Exploitability Document Generator
 *
 * Maps security finding triages and SBOM vulnerability advisories into
 * machine-readable OpenVEX v0.2.0 JSON documents for compliance & supply-chain audits.
 */

export const OPENVEX_CONTEXT_V020 = "https://openvex.dev/ns/v0.2.0";

export type OpenVexStatus = "not_affected" | "fixed" | "affected" | "under_investigation";

export type OpenVexJustification =
  | "component_not_present"
  | "vulnerable_code_not_present"
  | "vulnerable_code_not_in_execute_path"
  | "vulnerable_code_cannot_be_controlled_by_adversary"
  | "inline_mitigations_already_exist";

export const VALID_OPENVEX_JUSTIFICATIONS: ReadonlySet<OpenVexJustification> = new Set([
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
]);

export interface OpenVexProduct {
  "@id": string;
  identifiers?: {
    purl?: string;
    cpe23?: string;
  };
  subcomponents?: Array<{
    "@id": string;
    identifiers?: {
      purl?: string;
    };
  }>;
}

export interface OpenVexVulnerability {
  "@id"?: string;
  name: string;
  description?: string;
  aliases?: string[];
}

export interface OpenVexStatement {
  "@id"?: string;
  vulnerability: OpenVexVulnerability;
  products: OpenVexProduct[];
  status: OpenVexStatus;
  justification?: OpenVexJustification;
  impact_statement?: string;
  action_statement?: string;
  action_statement_timestamp?: string;
  status_notes?: string;
  timestamp: string;
}

export interface OpenVexDocument {
  "@context": typeof OPENVEX_CONTEXT_V020;
  "@id": string;
  author: string;
  role?: string;
  timestamp: string;
  last_updated?: string;
  version: number;
  tooling: string;
  statements: OpenVexStatement[];
}

export interface OpenVexStatementInput {
  vulnerabilityId: string;
  vulnerabilityDescription?: string;
  aliases?: string[];
  productPurl: string;
  subcomponentPurls?: string[];
  triageStatus?: string;
  vexStatus?: OpenVexStatus;
  justification?: OpenVexJustification;
  impactStatement?: string;
  actionStatement?: string;
  statusNotes?: string;
  timestamp?: string;
}

export interface OpenVexDocumentOptions {
  documentId?: string;
  author?: string;
  role?: string;
  timestamp?: string;
  version?: number;
  tooling?: string;
}

export function mapTriageToVexStatus(triageStatus?: string): {
  status: OpenVexStatus;
  defaultJustification?: OpenVexJustification;
  defaultImpact?: string;
  defaultAction?: string;
} {
  const normalized = (triageStatus ?? "OPEN").trim().toUpperCase();
  switch (normalized) {
    case "FALSE_POSITIVE":
      return {
        status: "not_affected",
        defaultJustification: "vulnerable_code_not_present",
        defaultImpact: "Triaged as false positive; vulnerable code path is not present.",
      };
    case "SUPPRESSED":
    case "ACCEPTED_RISK":
      return {
        status: "not_affected",
        defaultJustification: "inline_mitigations_already_exist",
        defaultImpact: "Risk accepted or mitigated via compensating controls.",
      };
    case "RESOLVED":
    case "FIXED":
      return {
        status: "fixed",
      };
    case "IN_REVIEW":
    case "UNDER_INVESTIGATION":
      return {
        status: "under_investigation",
      };
    case "OPEN":
    case "CONFIRMED":
    default:
      return {
        status: "affected",
        defaultAction: "Remediate or upgrade the affected component to a patched version.",
      };
  }
}

/**
 * Build a spec-compliant OpenVEX v0.2.0 statement from a finding/advisory input.
 */
export function buildOpenVexStatement(
  input: OpenVexStatementInput,
  fallbackTimestamp: string,
): OpenVexStatement {
  const mapped = mapTriageToVexStatus(input.triageStatus);
  const status: OpenVexStatus = input.vexStatus ?? mapped.status;
  const timestamp = input.timestamp ?? fallbackTimestamp;

  const product: OpenVexProduct = {
    "@id": input.productPurl,
    identifiers: input.productPurl.startsWith("pkg:") ? { purl: input.productPurl } : undefined,
    ...(input.subcomponentPurls && input.subcomponentPurls.length > 0
      ? {
          subcomponents: input.subcomponentPurls.map((purl) => ({
            "@id": purl,
            identifiers: purl.startsWith("pkg:") ? { purl } : undefined,
          })),
        }
      : {}),
  };

  const statement: OpenVexStatement = {
    vulnerability: {
      name: input.vulnerabilityId,
      ...(input.vulnerabilityDescription ? { description: input.vulnerabilityDescription } : {}),
      ...(input.aliases && input.aliases.length > 0 ? { aliases: input.aliases } : {}),
    },
    products: [product],
    status,
    timestamp,
    ...(input.statusNotes ? { status_notes: input.statusNotes } : {}),
  };

  if (status === "not_affected") {
    statement.justification = input.justification ?? mapped.defaultJustification;
    const impact = input.impactStatement ?? mapped.defaultImpact;
    if (impact) {
      statement.impact_statement = impact;
    }
  } else if (status === "affected") {
    statement.action_statement =
      input.actionStatement ?? mapped.defaultAction ?? "Upgrade or patch the affected component.";
    statement.action_statement_timestamp = timestamp;
  }

  return statement;
}

/**
 * Generate an OpenVEX v0.2.0 document from statement inputs.
 */
export function exportOpenVexDocument(
  inputs: OpenVexStatementInput[],
  options: OpenVexDocumentOptions = {},
): OpenVexDocument {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const statements = inputs.map((input) => buildOpenVexStatement(input, timestamp));

  const digest = createHash("sha256")
    .update(JSON.stringify({ timestamp, statements }))
    .digest("hex")
    .slice(0, 16);

  return {
    "@context": OPENVEX_CONTEXT_V020,
    "@id": options.documentId ?? `https://secureflow.dev/vex/${digest}`,
    author: options.author ?? "SecureFlow Compliance Engine",
    ...(options.role ? { role: options.role } : {}),
    timestamp,
    version: options.version ?? 1,
    tooling: options.tooling ?? "SecureFlow/0.1.0",
    statements,
  };
}

/**
 * Validate an OpenVEX v0.2.0 document against required schema and status invariants.
 */
export function validateOpenVexDocument(doc: OpenVexDocument): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (doc["@context"] !== OPENVEX_CONTEXT_V020) {
    errors.push(`Invalid @context: expected ${OPENVEX_CONTEXT_V020}`);
  }
  if (!doc["@id"] || typeof doc["@id"] !== "string") {
    errors.push("Missing document @id");
  }
  if (!doc.author || typeof doc.author !== "string") {
    errors.push("Missing document author");
  }
  if (!doc.timestamp || isNaN(Date.parse(doc.timestamp))) {
    errors.push("Invalid or missing document timestamp");
  }
  if (typeof doc.version !== "number" || doc.version < 1) {
    errors.push("Document version must be >= 1");
  }
  if (!Array.isArray(doc.statements)) {
    errors.push("Document statements must be an array");
    return { valid: false, errors };
  }

  doc.statements.forEach((stmt, idx) => {
    const prefix = `statements[${idx}]`;
    if (!stmt.vulnerability?.name) {
      errors.push(`${prefix}: missing vulnerability.name`);
    }
    if (!Array.isArray(stmt.products) || stmt.products.length === 0) {
      errors.push(`${prefix}: products must contain at least one product`);
    }
    if (stmt.status === "not_affected") {
      if (!stmt.justification && !stmt.impact_statement) {
        errors.push(`${prefix}: not_affected requires justification or impact_statement`);
      }
      if (stmt.justification && !VALID_OPENVEX_JUSTIFICATIONS.has(stmt.justification)) {
        errors.push(`${prefix}: invalid justification "${stmt.justification}"`);
      }
    }
    if (stmt.status === "affected" && !stmt.action_statement) {
      errors.push(`${prefix}: affected status requires action_statement`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Convert an AuditorComplianceDossier's findings sample into an OpenVEX v0.2.0 document.
 */
export function buildOpenVexFromDossier(
  dossier: AuditorComplianceDossier,
  options: OpenVexDocumentOptions & {
    productPurlPrefix?: string;
    triageByFindingId?: Record<
      string,
      { status: string; justification?: OpenVexJustification; actionStatement?: string }
    >;
  } = {},
): OpenVexDocument {
  const prefix = options.productPurlPrefix ?? "pkg:generic/secureflow";
  const inputs: OpenVexStatementInput[] = dossier.recentFindingsSample.map((finding) => {
    const override = options.triageByFindingId?.[finding.id];
    const encodedLocation = encodeURIComponent(finding.fileLocation || finding.id);
    return {
      vulnerabilityId: finding.cwe || finding.type,
      vulnerabilityDescription: `${finding.severity} finding (${finding.type}) in ${finding.fileLocation}`,
      aliases: finding.complianceTags,
      productPurl: `${prefix}/${encodedLocation}@${dossier.reportId}`,
      triageStatus: override?.status ?? "OPEN",
      justification: override?.justification,
      actionStatement: override?.actionStatement,
      timestamp: finding.createdAt || dossier.generatedAt,
    };
  });

  return exportOpenVexDocument(inputs, {
    documentId: options.documentId ?? `https://secureflow.dev/vex/${dossier.reportId}`,
    author: options.author ?? "SecureFlow Compliance Engine",
    timestamp: options.timestamp ?? dossier.generatedAt,
    version: options.version ?? 1,
  });
}
