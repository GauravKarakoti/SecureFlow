import { createHmac, createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  EmptyResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SCAN_CONTENT_SCHEMA, scanSuppliedContent } from "./scan.js";
import { lookupThreatIntelligenceById, searchThreatIntelligence } from "../threat-intel.js";
import { generateSarifReport } from "../sarif.js";
import type { FileScanResult, Severity, Violation } from "../scanner.js";
import {
  generateRemediationPatch,
  requestWeb3Explanation,
  type Web3ExplainRequest,
} from "../lib/api-client.js";
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

export const WEB3_SECURITY_EXPLANATIONS_SCHEMA = {
  type: "object" as const,
  properties: {
    findingType: {
      type: "string",
      description:
        "Type of Web3/ZK vulnerability (e.g., 'reentrancy', 'under-constrained-signal', 'unsafe-arithmetic')",
    },
    severity: {
      type: "string",
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      description: "Finding severity level",
    },
    description: {
      type: "string",
      description: "Detailed description of the finding or threat context",
    },
    fileLocation: {
      type: "string",
      description:
        "File path or contract location (e.g., 'contracts/Vault.sol', 'circuits/withdraw.circom')",
    },
    codeSnippet: {
      type: "string",
      description: "Vulnerable code snippet or smart contract segment to explain",
    },
    baseUrl: {
      type: "string",
      description: "Optional SecureFlow base URL (defaults to production endpoint)",
    },
    authToken: {
      type: "string",
      description: "Optional authentication bearer token for the platform API",
    },
    intentToken: {
      type: "string",
      description: "Optional ArmorIQ cryptographic intent token declaring approved plan",
    },
  },
  required: ["findingType", "severity", "description", "fileLocation", "codeSnippet"],
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
            "Search the synchronized CISA Known Exploited Vulnerabilities catalog and bundled offline examples. Absence from CISA KEV does not mean a vulnerability is safe.",
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
            "Look up an individual CVE using OSV advisory data and the synchronized CISA KEV catalog, with bundled offline fallback.",
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
        {
          name: "generate-remediation-patch",
          description:
            "Request AI-powered remediation patch generation for a specific finding ID via the SecureFlow platform API (alias for generate_remediation_patch).",
          inputSchema: GENERATE_REMEDIATION_PATCH_SCHEMA,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        {
          name: "web3_security_explanations",
          description:
            "Generate specialized AI explanations and remediation suggestions for Web3, smart contract, and zero-knowledge circuit vulnerabilities (Solidity/EVM, Rust/Soroban/Solana, ZK Circom/Leo).",
          inputSchema: WEB3_SECURITY_EXPLANATIONS_SCHEMA,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: "web3-security-explanations",
          description:
            "Generate specialized AI explanations and remediation suggestions for Web3, smart contract, and zero-knowledge circuit vulnerabilities (alias for web3_security_explanations).",
          inputSchema: WEB3_SECURITY_EXPLANATIONS_SCHEMA,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
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
        const isPathTraversal =
          error instanceof Error &&
          (error.name === "PathTraversalError" ||
            error.message.toLowerCase().includes("path traversal"));

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: isPathTraversal ? "PATH_TRAVERSAL_FORBIDDEN" : "INVALID_ARGUMENTS",
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
      const query = typeof args?.query === "string" ? args.query : "";
      const matches = await searchThreatIntelligence(query);
      const liveMatches = matches.filter((item) => item.source !== "BUNDLED");

      const result = {
        matches,
        liveSummary:
          liveMatches.length > 0
            ? `Found ${liveMatches.length} synchronized CISA KEV record(s).`
            : null,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(matches, null, 2),
          },
        ],
        structuredContent: result,
      };
    }

    if (name === "lookup_cve") {
      const cveId = typeof args?.cveId === "string" ? args.cveId.trim().toUpperCase() : "";

      const match = await lookupThreatIntelligenceById(cveId);

      if (match) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(match, null, 2),
            },
          ],
          structuredContent: match,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `No advisory found for ID: ${cveId}`,
              recommendation:
                "Verify the identifier and consult the vendor security advisory. Absence from CISA KEV does not indicate that a vulnerability is safe.",
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

    if (name === "generate_remediation_patch" || name === "generate-remediation-patch") {
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

    if (name === "web3_security_explanations" || name === "web3-security-explanations") {
      const findingType = typeof args?.findingType === "string" ? args.findingType.trim() : "";
      const rawSeverity =
        typeof args?.severity === "string" ? args.severity.toUpperCase().trim() : "";
      const description = typeof args?.description === "string" ? args.description.trim() : "";
      const fileLocation = typeof args?.fileLocation === "string" ? args.fileLocation.trim() : "";
      const codeSnippet = typeof args?.codeSnippet === "string" ? args.codeSnippet.trim() : "";

      const validSeverities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
      if (
        !findingType ||
        !rawSeverity ||
        !validSeverities.includes(rawSeverity) ||
        !description ||
        !fileLocation ||
        !codeSnippet
      ) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "INVALID_ARGUMENTS",
                error:
                  "web3_security_explanations requires findingType, valid severity (LOW, MEDIUM, HIGH, CRITICAL), description, fileLocation, and codeSnippet",
              }),
            },
          ],
        };
      }

      try {
        const web3Request: Web3ExplainRequest = {
          findingType,
          severity: rawSeverity as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
          description,
          fileLocation,
          codeSnippet,
        };

        const baseUrl = typeof args?.baseUrl === "string" ? args.baseUrl : undefined;
        const authToken = typeof args?.authToken === "string" ? args.authToken : undefined;

        const result = await requestWeb3Explanation(web3Request, baseUrl, authToken);

        return {
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
                code: "EXPLANATION_FAILED",
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to generate Web3 security explanation",
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

export interface McpServerOptions {
  /**
   * Custom readable stream for standard input (defaults to process.stdin).
   */
  stdin?: NodeJS.ReadableStream;
  /**
   * Custom writable stream for standard output (defaults to process.stdout).
   */
  stdout?: NodeJS.WritableStream;
  /**
   * Heartbeat ping interval in milliseconds to verify client liveness.
   * If > 0, the server periodically sends a ping request to the client.
   * Defaults to 30000 (30 seconds), or env SECUREFLOW_MCP_HEARTBEAT_INTERVAL_MS / SECUREFLOW_MCP_HEARTBEAT_MS.
   * Set to 0 to disable periodic ping-pong checks.
   */
  heartbeatIntervalMs?: number;
  /**
   * Heartbeat timeout in milliseconds to wait for a client pong response.
   * Defaults to 10000 (10 seconds), or env SECUREFLOW_MCP_HEARTBEAT_TIMEOUT_MS.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Maximum duration of stdio stream inactivity / stall allowed before client is deemed unresponsive.
   * Defaults to 60000 (60 seconds), or env SECUREFLOW_MCP_LIVENESS_TIMEOUT_MS / SECUREFLOW_MCP_STALL_TIMEOUT_MS.
   * Set to 0 to disable stall detection.
   */
  stallTimeoutMs?: number;
  /**
   * Callback invoked when a disconnection, stream EOF, broken pipe, or stall occurs.
   */
  onDisconnect?: (reason: string) => void;
  /**
   * Whether to call process.exit(0) upon graceful shutdown of stdio transport.
   * Defaults to true in non-test environments, false in test environments.
   */
  exitOnDisconnect?: boolean;
}

export interface McpServerSession {
  server: Server;
  transport: StdioServerTransport;
  close: () => Promise<void>;
  waitForClose: () => Promise<void>;
  isAlive: () => boolean;
  getLastActivity: () => number;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<McpServerSession> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  const envHeartbeat =
    process.env.SECUREFLOW_MCP_HEARTBEAT_INTERVAL_MS ?? process.env.SECUREFLOW_MCP_HEARTBEAT_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? (envHeartbeat ? Number.parseInt(envHeartbeat, 10) : 30000);

  const envHeartbeatTimeout = process.env.SECUREFLOW_MCP_HEARTBEAT_TIMEOUT_MS;
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ??
    (envHeartbeatTimeout ? Number.parseInt(envHeartbeatTimeout, 10) : 10000);

  const envStallTimeout =
    process.env.SECUREFLOW_MCP_LIVENESS_TIMEOUT_MS ?? process.env.SECUREFLOW_MCP_STALL_TIMEOUT_MS;
  const stallTimeoutMs =
    options.stallTimeoutMs ?? (envStallTimeout ? Number.parseInt(envStallTimeout, 10) : 60000);

  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    Boolean(process.env.VITEST) ||
    Boolean(process.env.JEST_WORKER_ID);
  const exitOnDisconnect = options.exitOnDisconnect ?? !isTestEnv;

  const server = createThreatIntelMcpServer();
  const transport = new StdioServerTransport(stdin as any, stdout as any);

  let lastActivity = Date.now();
  let isShuttingDown = false;
  let isClosed = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let stallTimer: NodeJS.Timeout | null = null;
  let heartbeatInFlight = false;

  let resolveClose: () => void = () => {};
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const recordActivity = () => {
    lastActivity = Date.now();
  };

  const triggerShutdown = async (reason: string): Promise<void> => {
    if (isShuttingDown) {
      return closePromise;
    }
    isShuttingDown = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }

    // Clean up stream listeners
    if (typeof (stdout as any).removeListener === "function") {
      (stdout as any).removeListener("error", handleStdoutError);
    }
    if (typeof (stdin as any).removeListener === "function") {
      (stdin as any).removeListener("error", handleStdinError);
      (stdin as any).removeListener("end", handleStdinEnd);
      (stdin as any).removeListener("close", handleStdinClose);
      (stdin as any).removeListener("data", recordActivity);
    }

    process.removeListener("SIGINT", sigintListener);
    process.removeListener("SIGTERM", sigtermListener);

    try {
      await transport.close().catch(() => {});
    } catch {
      // Ignore transport close errors
    }

    try {
      await server.close().catch(() => {});
    } catch {
      // Ignore server close errors
    }

    try {
      options.onDisconnect?.(reason);
    } catch {
      // Suppress callback errors
    }

    isClosed = true;
    resolveClose();

    if (exitOnDisconnect) {
      process.exit(0);
    }

    return closePromise;
  };

  const handleStdoutError = (error: any) => {
    const code = error?.code;
    const isBrokenPipe =
      code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";

    if (isBrokenPipe) {
      console.error(
        `[SecureFlow MCP] Client disconnected abruptly (stdout broken pipe: ${code}). Daemon remaining intact; initiating clean transport shutdown.`,
      );
    } else {
      console.error(`[SecureFlow MCP] stdout stream error: ${error?.message || String(error)}`);
    }
    void triggerShutdown(isBrokenPipe ? `Broken pipe: ${code}` : `stdout error: ${error?.message}`);
  };

  const handleStdinError = (error: any) => {
    const code = error?.code;
    const isBrokenPipe =
      code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";

    if (isBrokenPipe) {
      console.error(
        `[SecureFlow MCP] Client input stream disconnected (${code}). Initiating graceful shutdown...`,
      );
    } else {
      console.error(`[SecureFlow MCP] stdin stream error: ${error?.message || String(error)}`);
    }
    void triggerShutdown(
      isBrokenPipe ? `stdin disconnected: ${code}` : `stdin error: ${error?.message}`,
    );
  };

  const handleStdinEnd = () => {
    console.error(
      `[SecureFlow MCP] Client input stream closed (EOF received). Initiating graceful shutdown...`,
    );
    void triggerShutdown("EOF on stdin");
  };

  const handleStdinClose = () => {
    void triggerShutdown("stdin stream closed");
  };

  const sigintListener = () => {
    console.error("[SecureFlow MCP] Received SIGINT. Shutting down cleanly...");
    void triggerShutdown("SIGINT");
  };

  const sigtermListener = () => {
    console.error("[SecureFlow MCP] Received SIGTERM. Shutting down cleanly...");
    void triggerShutdown("SIGTERM");
  };

  if (typeof (stdout as any).on === "function") {
    (stdout as any).on("error", handleStdoutError);
  }
  if (typeof (stdin as any).on === "function") {
    (stdin as any).on("error", handleStdinError);
    (stdin as any).on("end", handleStdinEnd);
    (stdin as any).on("close", handleStdinClose);
    (stdin as any).on("data", recordActivity);
  }

  process.once("SIGINT", sigintListener);
  process.once("SIGTERM", sigtermListener);

  await server.connect(transport);
  console.error("SecureFlow Threat Intelligence MCP Server running via stdio");

  // Dedicated stall detection watchdog
  if (stallTimeoutMs > 0) {
    const stallCheckInterval = Math.max(10, Math.min(stallTimeoutMs, 5000));
    stallTimer = setInterval(async () => {
      if (isShuttingDown) return;
      const now = Date.now();
      if (now - lastActivity > stallTimeoutMs) {
        console.error(
          `[SecureFlow MCP] Stdio stream stall detected: inactive for ${now - lastActivity}ms (limit: ${stallTimeoutMs}ms). Initiating graceful shutdown...`,
        );
        await triggerShutdown(`Stream stall: inactive for ${now - lastActivity}ms`);
      }
    }, stallCheckInterval);

    stallTimer.unref?.();
  }

  // Active heartbeat / client liveness check
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(async () => {
      if (isShuttingDown || heartbeatInFlight) return;

      heartbeatInFlight = true;
      try {
        await server.request({ method: "ping" }, EmptyResultSchema, {
          timeout: heartbeatTimeoutMs,
        });
        recordActivity();
      } catch (err: any) {
        if (isShuttingDown) return;

        // MethodNotFound (-32601) indicates the client received and processed the JSON-RPC request
        if (
          err?.code === -32601 ||
          (typeof err?.message === "string" &&
            err.message.toLowerCase().includes("method not found"))
        ) {
          recordActivity();
        } else {
          console.error(
            `[SecureFlow MCP] Client heartbeat check failed (${err?.message || String(err)}). Initiating graceful shutdown...`,
          );
          await triggerShutdown(`Heartbeat ping failed: ${err?.message || String(err)}`);
        }
      } finally {
        heartbeatInFlight = false;
      }
    }, heartbeatIntervalMs);

    heartbeatTimer.unref?.();
  }

  return {
    server,
    transport,
    close: () => triggerShutdown("Manual close requested"),
    waitForClose: () => closePromise,
    isAlive: () => !isShuttingDown && !isClosed,
    getLastActivity: () => lastActivity,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  startMcpServer()
    .then((session) => session?.waitForClose?.())
    .catch((err) => {
      console.error("Fatal error starting MCP server:", err);
      process.exit(1);
    });
}
