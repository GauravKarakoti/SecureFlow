import api, { route } from "@forge/api";

const VALID_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function normalizeSeverity(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const upper = raw.trim().toUpperCase();
  return VALID_SEVERITIES.includes(upper) ? upper : undefined;
}

async function fetchJiraIssueContext(issueKey) {
  const res = await api
    .asApp()
    .requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,status,priority,issuetype,labels,updated`,
    );
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  return {
    key: data.key,
    summary: data.fields?.summary ?? "",
    status: data.fields?.status?.name ?? "Unknown",
    priority: data.fields?.priority?.name ?? "Unspecified",
    issueType: data.fields?.issuetype?.name ?? "Issue",
    labels: Array.isArray(data.fields?.labels) ? data.fields.labels : [],
    updated: data.fields?.updated ?? null,
  };
}

async function queryTeamworkGraph(entityRef) {
  const query = `
    query SecureFlowTeamworkContext($query: String!) {
      teamworkGraph {
        search(query: $query, first: 5) {
          nodes {
            id
            ... on JiraIssue {
              key
              summary
            }
            ... on ConfluencePage {
              title
              url
            }
          }
        }
      }
    }
  `;

  const res = await api.asApp().requestGraph(query, { query: entityRef });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Teamwork Graph query failed (${res.status}): ${errorText}`);
  }
  return res.json();
}

export async function triageSecurityContext(request) {
  const input = request?.payload ?? {};
  const target =
    (typeof input.target === "string" ? input.target.trim() : "") ||
    request?.context?.jira?.issue?.key ||
    request?.context?.jira?.project?.key ||
    "";

  if (!target) {
    return {
      ok: false,
      error: "Missing required parameter: target (repository, PR identifier, or Jira issue key).",
    };
  }

  const severityFilter = normalizeSeverity(input.severityFilter);
  const jiraKeyMatch = target.match(/^[A-Z][A-Z0-9_]+-\d+$/i);

  let jiraIssue = null;
  let jiraLookupNote;

  if (jiraKeyMatch) {
    try {
      jiraIssue = await fetchJiraIssueContext(jiraKeyMatch[0].toUpperCase());
    } catch (err) {
      jiraLookupNote = err instanceof Error ? err.message : "Unable to fetch Jira issue details.";
    }
  }

  return {
    ok: true,
    target,
    severityFilter: severityFilter ?? "ALL",
    jiraIssue,
    jiraLookupNote,
    triageGuidance: {
      recommendedGate:
        jiraIssue?.priority === "Highest" || severityFilter === "CRITICAL"
          ? "BLOCK_AND_REMEDIATE"
          : "REQUIRE_REVIEW",
      nextSteps: [
        `Correlate findings and recent changes for "${target}" with linked Jira issues and architecture docs.`,
        "Verify policy compliance, dependency/SBOM risk, and approval sign-off before promoting release.",
      ],
    },
  };
}

export async function queryTeamworkContext(request) {
  const input = request?.payload ?? {};
  const entityRef =
    (typeof input.entityRef === "string" ? input.entityRef.trim() : "") ||
    request?.context?.jira?.issue?.key ||
    request?.context?.confluence?.content?.id ||
    "";

  if (!entityRef) {
    return {
      ok: false,
      error:
        "Missing required parameter: entityRef (Jira key, Confluence page/space, or service/repo).",
    };
  }

  try {
    const graphData = await queryTeamworkGraph(entityRef);
    return {
      ok: true,
      entityRef,
      teamworkGraph: graphData,
    };
  } catch (err) {
    return {
      ok: false,
      entityRef,
      error: err instanceof Error ? err.message : "Failed to query Teamwork Graph.",
    };
  }
}

export async function handleMcpRequest(request) {
  const method = request?.method ?? "tools/list";
  const id = request?.id ?? null;

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "triage_security_context",
            description:
              "Retrieve security triage context and release gate recommendation for a target.",
            inputSchema: {
              type: "object",
              properties: {
                target: { type: "string", description: "Repo, PR, or Jira issue key" },
                severityFilter: {
                  type: "string",
                  enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
                },
              },
              required: ["target"],
            },
          },
          {
            name: "query_teamwork_context",
            description:
              "Fetch related work items, pages, and context from Atlassian Teamwork Graph.",
            inputSchema: {
              type: "object",
              properties: {
                entityRef: {
                  type: "string",
                  description: "Entity key, page ID, or service identifier",
                },
              },
              required: ["entityRef"],
            },
          },
        ],
      },
    };
  }

  if (method === "tools/call") {
    const params = request?.params ?? {};
    const toolName = params.name;
    const args = params.arguments ?? {};

    if (toolName === "triage_security_context") {
      const result = await triageSecurityContext({ payload: args });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    }

    if (toolName === "query_teamwork_context") {
      const result = await queryTeamworkContext({ payload: args });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Unknown MCP tool: ${String(toolName)}`,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Unsupported MCP method: ${method}`,
    },
  };
}
