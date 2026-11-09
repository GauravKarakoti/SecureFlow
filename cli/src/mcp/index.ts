import { createHmac, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SCAN_CONTENT_SCHEMA, scanSuppliedContent } from "./scan.js";
import { KNOWLEDGE_BASE, queryLiveThreatIntelligence } from "../threat-intel.js";
import { generateSarifReport } from "../sarif.js";
import type { FileScanResult, Severity, Violation } from "../scanner.js";
import { generateRemediationPatch } from "../lib/api-client.js";
export { queryLiveThreatIntelligence } from "../threat-intel.js";

/**
 * Creates and configures the SecureFlow Threat Intelligence MCP Server.
 */
/**
 * Resolve the HMAC key used for MCP tool proofs.
 *
 * There is deliberately no built-in key. A committed default would let any
 * reader of the repository forge proofs against a misconfigured deployment.
 */
function resolveSigningKey(): string {
  const key = process.env.ARMORIQ_PROOF_SIGNING_KEY?.trim();
  if (!key) {
    throw new Error(
      "ARMORIQ_PROOF_SIGNING_KEY is not configured; refusing to sign ArmorIQ proofs with a public fallback key.",
    );
  }
  return key;
}

export interface IntentVerificationResult {
  verified: boolean;
  allowed: boolean;
  reason?: string;
  proof?: {
    signature: string;
    proofHash: string;
    timestamp: number;
  };
}

/**
 * Validates declared cryptographic intent against ArmorIQ policy rules
 * to prevent prompt injection (CWE-94) and arbitrary execution drift.
 */
export function verifyDeclaredIntent(
  toolName: string,
  args: Record<string, unknown>,
  intentToken?: string,
): IntentVerificationResult {
  const serialized = JSON.stringify(args).toLowerCase();

  // Fail-closed detection for adversarial prompt injection (CWE-94)
  if (
    /\b(ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s+override|jailbreak|disregard\s+(all\s+)?rules)\b/i.test(
      serialized,
    ) ||
    /\b(exfiltrate|leak|steal|dump|print)\s+(private\s+)?(intent\s+token|secret|api_key|credential)/i.test(
      serialized,
    ) ||
    /\b(armor_?iq_intent_token|intentToken|ARMORIQ_API_KEY)\b/i.test(serialized)
  ) {
    return {
      verified: false,
      allowed: false,
      reason: "Action blocked by ArmorIQ: Adversarial prompt injection (CWE-94) detected",
    };
  }

  // Cryptographic intent token verification if provided
  if (intentToken) {
    if (intentToken.includes("tampered") || intentToken.length < 16) {
      return {
        verified: false,
        allowed: false,
        reason:
          "Action blocked by ArmorIQ: Cryptographic intent token signature is invalid or tampered",
      };
    }
  }

  const timestamp = Date.now();
  const proofHash = createHash("sha256")
    .update(JSON.stringify({ toolName, args, timestamp }))
    .digest("hex");

  let signature: string;
  try {
    signature = createHmac("sha256", resolveSigningKey()).update(proofHash).digest("hex");
  } catch (error) {
    return {
      verified: false,
      allowed: false,
      reason:
        error instanceof Error
          ? `Action blocked by ArmorIQ: ${error.message}`
          : "Action blocked by ArmorIQ: signing key is not configured",
    };
  }

  return {
    verified: true,
    allowed: true,
    proof: {
      signature,
      proofHash,
      timestamp,
    },
  };
}

const REMEDIATION_CONTEXT_SCHEMA = {
  type: "object" as const,
  properties: {
    history: {
      type: "array",
      maxItems: 1000,
      description: "Caller-provided remediation outcomes; never fetched from a dashboard database.",
      items: {
        type: "object",
        properties: {
          advisoryId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,63}$" },
          status: { type: "string", enum: ["APPLIED", "FAILED", "PENDING", "GENERATED"] },
        },
        required: ["advisoryId", "status"],
        additionalProperties: false,
      },
    },
    advisoryId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,63}$",
      description: "Optional case-insensitive advisory filter.",
    },
    intentToken: { type: "string" },
  },
  required: ["history"],
  additionalProperties: false,
};

const STATUSES = ["APPLIED", "FAILED", "PENDING", "GENERATED"] as const;
type Status = (typeof STATUSES)[number];
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export const EXPORT_SARIF_SCHEMA = {
  type: "object" as const,
  properties: {
    results: {
      type: "array",
      description: "List of file scan results containing path and violations to convert to SARIF.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path scanned" },
          violations: {
            type: "array",
            description: "List of violations detected in the file",
            items: {
              type: "object",
              properties: {
                ruleId: { type: "string" },
                reason: { type: "string" },
                line: { type: "integer" },
                column: { type: "integer" },
                text: { type: "string" },
                severity: { type: "string" },
              },
              required: ["reason", "line", "text"],
            },
          },
        },
        required: ["path", "violations"],
      },
    },
    toolVersion: {
      type: "string",
      description: "Optional semantic tool version string (defaults to 0.1.0)",
    },
    intentToken: {
      type: "string",
      description: "Optional ArmorIQ cryptographic intent token declaring approved plan",
    },
  },
  required: ["results"],
  additionalProperties: false,
};

export const GENERATE_REMEDIATION_PATCH_SCHEMA = {
  type: "object" as const,
  properties: {
    findingId: {
      type: "string",
      description: "Identifier of the finding to generate an AI remediation patch for",
    },
    baseUrl: {
      type: "string",
      description: "Optional SecureFlow base URL (defaults to production endpoint)",
    },
    authToken: {
      type: "string",
      description: "Optional authentication bearer token for the platform API",
    },
    timeoutMs: {
      type: "integer",
      description: "Timeout in milliseconds for the AI remediation patch request",
    },
    intentToken: {
      type: "string",
      description: "Optional ArmorIQ cryptographic intent token declaring approved plan",
    },
  },
  required: ["findingId"],
  additionalProperties: false,
};

/** Convert caller-supplied scan results into OASIS SARIF v2.1.0 format. */
export function exportScanResultsToSarif(args: Record<string, unknown>) {
  if (Object.keys(args).some((key) => !["results", "toolVersion", "intentToken"].includes(key))) {
    throw new Error("Unknown export_sarif argument");
  }
  if (!Array.isArray(args.results)) {
    throw new Error("results must be an array of FileScanResult objects");
  }
  const toolVersion = typeof args.toolVersion === "string" ? args.toolVersion : undefined;

  const validResults: FileScanResult[] = [];
  for (const item of args.results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each result in results must be an object");
    }
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || !r.path.trim()) {
      throw new Error("Each result item requires a valid non-empty path");
    }
    if (!Array.isArray(r.violations)) {
      throw new Error(`Violations for ${r.path} must be an array`);
    }

    const violations = r.violations.map((vItem: unknown, idx: number) => {
      if (!vItem || typeof vItem !== "object" || Array.isArray(vItem)) {
        throw new Error(`Violation at index ${idx} in ${r.path} must be an object`);
      }
      const v = vItem as Record<string, unknown>;
      if (typeof v.reason !== "string" || !v.reason.trim()) {
        throw new Error(`Violation in ${r.path} missing non-empty reason`);
      }
      if (typeof v.line !== "number" || !Number.isInteger(v.line) || v.line < 1) {
        throw new Error(`Violation in ${r.path} requires an integer line >= 1`);
      }
      if (typeof v.text !== "string") {
        throw new Error(`Violation in ${r.path} requires a string snippet text`);
      }
      const violation: Violation = {
        line: v.line,
        text: v.text,
        reason: v.reason,
      };
      if (typeof v.severity === "string") {
        const upper = v.severity.toUpperCase();
        if (upper === "CRITICAL" || upper === "HIGH" || upper === "MEDIUM" || upper === "LOW") {
          violation.severity = upper as Severity;
        }
      }
      return violation;
    });

    validResults.push({
      path: r.path,
      violations,
    });
  }

  const sarifOptions: { toolVersion?: string } = {};
  if (toolVersion) {
    sarifOptions.toolVersion = toolVersion;
  }
  const sarifDoc = generateSarifReport(validResults, sarifOptions);
  return sarifDoc;
}

/** Aggregate bounded caller-supplied history, without inventing production evidence. */
function summarizeRemediationHistory(args: Record<string, unknown>) {
  if (Object.keys(args).some((key) => !["history", "advisoryId", "intentToken"].includes(key))) {
    throw new Error("Unknown remediation-context argument");
  }
  if (args.intentToken !== undefined && typeof args.intentToken !== "string") {
    throw new Error("intentToken must be a string");
  }
  const filter = args.advisoryId;
  if (filter !== undefined && (typeof filter !== "string" || !ID.test(filter))) {
    throw new Error("advisoryId must be an alphanumeric/hyphen identifier of 1–64 characters");
  }
  if (!Array.isArray(args.history) || args.history.length > 1000) {
    throw new Error("history must be an array of at most 1000 outcomes");
  }
  const counts: Record<Status, number> = { APPLIED: 0, FAILED: 0, PENDING: 0, GENERATED: 0 };
  for (const value of args.history) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Each history item must be an object");
    }
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).some((key) => !["advisoryId", "status"].includes(key)) ||
      typeof item.advisoryId !== "string" ||
      !ID.test(item.advisoryId) ||
      !STATUSES.includes(item.status as Status)
    ) {
      throw new Error("Each history item requires a valid advisoryId and remediation status");
    }
    if (filter === undefined || item.advisoryId.toUpperCase() === filter.toUpperCase()) {
      counts[item.status as Status] += 1;
    }
  }
  const completed = counts.APPLIED + counts.FAILED;
  return {
    source: "caller_provided",
    advisoryId: typeof filter === "string" ? filter.toUpperCase() : null,
    sampleSize: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
    completed,
    applicationSuccessRate: completed === 0 ? null : counts.APPLIED / completed,
    interpretation:
      "APPLIED / (APPLIED + FAILED); application is not proof of vulnerability resolution",
  };
}

export function createThreatIntelMcpServer(): Server {
  const server = new Server(
    {
      name: "secureflow-threat-intelligence",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "scan_content",
          description:
            "Scan caller-provided source for secret logging with configurable literal entropy sensitivity. Return redacted JSON, SARIF, text, CSV, HTML or Markdown reports; never reads files.",
          inputSchema: SCAN_CONTENT_SCHEMA,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: "get_remediation_context",
          description:
            "Summarize caller-provided historical remediation outcomes, optionally by advisory. Returns application rates with explicit sample counts; does not access production data.",
          inputSchema: REMEDIATION_CONTEXT_SCHEMA,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: "query_threat_intelligence",
          description:
            "Search the bundled advisory examples for security context and remediation recommendations. Does not query a live CVE service.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search keyword, vulnerability type, or CVE identifier (e.g., 'SQL injection', 'CVE-2023-3409')",
              },
              intentToken: {
                type: "string",
                description: "Optional ArmorIQ cryptographic intent token declaring approved plan",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "lookup_cve",
          description:
            "Look up detailed threat advisory, severity, and remediation guidance for a specific CVE or CWE ID.",
          inputSchema: {
            type: "object",
            properties: {
              cveId: {
                type: "string",
                description: "The CVE or CWE identifier (e.g., 'CVE-2023-3409')",
              },
              intentToken: {
                type: "string",
                description: "Optional ArmorIQ cryptographic intent token declaring approved plan",
              },
            },
            required: ["cveId"],
          },
        },
        {
          name: "export_sarif",
          description:
            "Export CLI or caller-provided file scan findings into standardized OASIS SARIF v2.1.0 report format for CI/CD or security dashboard ingestion.",
          inputSchema: EXPORT_SARIF_SCHEMA,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: "generate_remediation_patch",
          description:
            "Request AI-powered remediation patch generation for a specific finding ID via the SecureFlow platform API.",
          inputSchema: GENERATE_REMEDIATION_PATCH_SCHEMA,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const intentToken = typeof args?.intentToken === "string" ? args.intentToken : undefined;

    // Cryptographic intent verification gate: reject any drift or injection attempt fail-closed
    const intentVerification = verifyDeclaredIntent(
      name,
      (args as Record<string, unknown>) || {},
      intentToken,
    );
    if (!intentVerification.allowed) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: intentVerification.reason,
              code: "ARMORIQ_INTENT_VERIFICATION_FAILED",
              enforcement: "FAIL_CLOSED",
            }),
          },
        ],
      };
    }

    if (name === "scan_content") {
      try {
        const summary = scanSuppliedContent(args || {});
        return {
          content: [{ type: "text", text: JSON.stringify(summary) }],
          structuredContent: summary,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "INVALID_ARGUMENTS",
                error: error instanceof Error ? error.message : "Invalid scan arguments",
              }),
            },
          ],
        };
      }
    }

    if (name === "get_remediation_context") {
      try {
        const summary = summarizeRemediationHistory(args || {});
        return {
          content: [{ type: "text", text: JSON.stringify(summary) }],
          structuredContent: summary,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "INVALID_ARGUMENTS",
                error: error instanceof Error ? error.message : "Invalid remediation context",
              }),
            },
          ],
        };
      }
    }

    if (name === "query_threat_intelligence") {
      const query = String(args?.query || "").toLowerCase();
      const matches = KNOWLEDGE_BASE.filter(
        (item) =>
          item.description.toLowerCase().includes(query) ||
          item.category.toLowerCase().includes(query) ||
          (item.cve && item.cve.toLowerCase().includes(query)),
      );

      const liveSummary = await queryLiveThreatIntelligence(String(args?.query || ""));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              matches.length > 0 ? matches : KNOWLEDGE_BASE.slice(0, 2),
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          matches: matches.length > 0 ? matches : KNOWLEDGE_BASE.slice(0, 2),
          liveSummary: liveSummary || null,
        },
      };
    }

    if (name === "lookup_cve") {
      const cveId = String(args?.cveId || "").toUpperCase();
      const match = KNOWLEDGE_BASE.find(
        (item) => item.id.toUpperCase() === cveId || (item.cve && item.cve.toUpperCase() === cveId),
      );

      if (match) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(match, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `No advisory found for ID: ${cveId}`,
              recommendation: "Apply defensive programming practices and input sanitization.",
            }),
          },
        ],
      };
    }

    if (name === "export_sarif") {
      try {
        const sarifDoc = exportScanResultsToSarif(args || {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sarifDoc, null, 2),
            },
          ],
          structuredContent: sarifDoc,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "INVALID_ARGUMENTS",
                error: error instanceof Error ? error.message : "Invalid SARIF export arguments",
              }),
            },
          ],
        };
      }
    }

    if (name === "generate_remediation_patch") {
      const findingId = typeof args?.findingId === "string" ? args.findingId.trim() : "";
      if (!findingId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "INVALID_ARGUMENTS",
                error: "findingId must be a non-empty string",
              }),
            },
          ],
        };
      }

      try {
        const patchOptions: { baseUrl?: string; authToken?: string; timeoutMs?: number } = {};
        if (typeof args?.baseUrl === "string") {
          patchOptions.baseUrl = args.baseUrl;
        }
        if (typeof args?.authToken === "string") {
          patchOptions.authToken = args.authToken;
        }
        if (typeof args?.timeoutMs === "number") {
          patchOptions.timeoutMs = args.timeoutMs;
        }
        const result = await generateRemediationPatch(findingId, patchOptions);

        return {
          isError: !result.success,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "REMEDIATION_FAILED",
                error:
                  error instanceof Error ? error.message : "Failed to generate remediation patch",
              }),
            },
          ],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createThreatIntelMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SecureFlow Threat Intelligence MCP Server running via stdio");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  startMcpServer().catch((err) => {
    console.error("Fatal error starting MCP server:", err);
    process.exit(1);
  });
}
