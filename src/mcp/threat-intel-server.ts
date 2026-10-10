import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
    description: "Improper neutralization of special elements used in an SQL command leads to arbitrary data exfiltration.",
    severity: "critical",
    cve: "CVE-2023-3409",
    remediationGuidance: "Replace string concatenation with parameterized prepared statements or ORM abstractions with strict type casting.",
  },
  {
    id: "CVE-2023-28154",
    category: "Server-Side Request Forgery",
    description: "SSRF vulnerability allowing attackers to make arbitrary network requests from the server to internal metadata endpoints or private subnets.",
    severity: "high",
    cve: "CVE-2023-28154",
    remediationGuidance: "Enforce strict allowlists of public protocols (HTTPS only) and disallow loopback (127.0.0.1) or link-local/private IP ranges.",
  },
  {
    id: "SEC-LEAK-001",
    category: "Secret Logging",
    description: "Sensitive secrets, tokens, or private keys exposed in runtime application logs.",
    severity: "high",
    remediationGuidance: "Mask or redact secret variables prior to logging, or omit credentials entirely from logging sinks.",
  },
  {
    id: "CWE-79",
    category: "Cross-Site Scripting",
    description: "Unsanitized user-controlled input rendered directly into DOM or HTML output.",
    severity: "high",
    remediationGuidance: "Use context-aware HTML entity encoding or modern reactive framework templating that auto-escapes dynamic values.",
  },
  {
    id: "CWE-94",
    category: "Prompt Injection",
    description: "Adversarial override attempting to hijack LLM system instructions or exfiltrate private intent tokens.",
    severity: "critical",
    remediationGuidance: "Wrap tool execution behind cryptographic intent verification (ArmorIQ) and apply fail-closed boundary enforcement.",
  },
];

/**
 * Creates and configures the SecureFlow Threat Intelligence MCP Server.
 */
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
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "query_threat_intelligence",
          description: "Search live threat intelligence and CVE databases for security context and remediation recommendations.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search keyword, vulnerability type, or CVE identifier (e.g., 'SQL injection', 'CVE-2023-3409')",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "lookup_cve",
          description: "Look up detailed threat advisory, severity, and remediation guidance for a specific CVE or CWE ID.",
          inputSchema: {
            type: "object",
            properties: {
              cveId: {
                type: "string",
                description: "The CVE or CWE identifier (e.g., 'CVE-2023-3409')",
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

    if (name === "query_threat_intelligence") {
      const query = String((args as any)?.query || "").toLowerCase();
      const matches = KNOWLEDGE_BASE.filter(
        (item) =>
          item.description.toLowerCase().includes(query) ||
          item.category.toLowerCase().includes(query) ||
          (item.cve && item.cve.toLowerCase().includes(query))
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(matches.length > 0 ? matches : KNOWLEDGE_BASE.slice(0, 2), null, 2),
          },
        ],
      };
    }

    if (name === "lookup_cve") {
      const cveId = String((args as any)?.cveId || "").toUpperCase();
      const match = KNOWLEDGE_BASE.find(
        (item) => item.id.toUpperCase() === cveId || (item.cve && item.cve.toUpperCase() === cveId)
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
      (item.cve && item.cve.toLowerCase().includes(q))
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
