import { createHmac, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface ThreatIntelligenceEntry {
  id: string;
  category: string;
  description: string;
  severity: string;
  cve?: string;
  remediationGuidance: string;
}

export const KNOWLEDGE_BASE: ThreatIntelligenceEntry[] = [
  {
    id: "CVE-2023-3409",
    category: "SQL Injection",
    description:
      "Improper neutralization of special elements used in an SQL command leads to arbitrary data exfiltration.",
    severity: "critical",
    cve: "CVE-2023-3409",
    remediationGuidance:
      "Replace string concatenation with parameterized prepared statements or ORM abstractions with strict type casting.",
  },
  {
    id: "CVE-2023-28154",
    category: "Server-Side Request Forgery",
    description:
      "SSRF vulnerability allowing attackers to make arbitrary network requests from the server to internal metadata endpoints or private subnets.",
    severity: "high",
    cve: "CVE-2023-28154",
    remediationGuidance:
      "Enforce strict allowlists of public protocols (HTTPS only) and disallow loopback (127.0.0.1) or link-local/private IP ranges.",
  },
  {
    id: "SEC-LEAK-001",
    category: "Secret Logging",
    description: "Sensitive secrets, tokens, or private keys exposed in runtime application logs.",
    severity: "high",
    remediationGuidance:
      "Mask or redact secret variables prior to logging, or omit credentials entirely from logging sinks.",
  },
  {
    id: "CWE-79",
    category: "Cross-Site Scripting",
    description: "Unsanitized user-controlled input rendered directly into DOM or HTML output.",
    severity: "high",
    remediationGuidance:
      "Use context-aware HTML entity encoding or modern reactive framework templating that auto-escapes dynamic values.",
  },
  {
    id: "CWE-94",
    category: "Prompt Injection",
    description:
      "Adversarial override attempting to hijack LLM system instructions or exfiltrate private intent tokens.",
    severity: "critical",
    remediationGuidance:
      "Wrap tool execution behind cryptographic intent verification (ArmorIQ) and apply fail-closed boundary enforcement.",
  },
];

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

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

export async function queryLiveThreatIntelligence(query: string): Promise<string> {
  const q = query.toLowerCase();
  const match = KNOWLEDGE_BASE.find(
    (item) =>
      item.description.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      (item.cve && item.cve.toLowerCase().includes(q)),
  );

  if (match) {
    return `[Threat Intelligence Advisory - ${match.id} (${match.severity.toUpperCase()})]
Category: ${match.category}
Guidance: ${match.remediationGuidance}`;
  }

  return "";
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
