import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import {
  normalizeFindingTypeEnum,
  normalizePolicyDecisionEnum,
  normalizePrStatusEnum,
  normalizePrStateEnum,
} from "@/lib/finding-taxonomy";
import { normalizeSeverity } from "@/lib/severity";

vi.mock("@/lib/prisma", () => ({
  default: {
    pullRequest: {
      upsert: vi.fn(),
    },
    scanResult: {
      create: vi.fn(),
    },
  },
}));

describe("Worker Database Persistence Schema Mapping (#633)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("properly converts raw GitHub and scanner data to valid Prisma enum shapes", async () => {
    const rawPullRequest = {
      id: 998877,
      number: 42,
      title: "Add payment webhook handler",
      state: "open",
    };
    const rawDecision = "REVIEW REQUIRED";
    const rawFindings = [
      {
        type: "Hardcoded Secret",
        severity: "critical",
        fileLocation: "src/config/stripe.ts",
        lineStart: 12,
        lineEnd: 12,
        codeSnippet: 'const stripeKey = "sk_live_123456";',
        explanation: "Exposed Stripe production secret.",
        remediation: "Move stripe key to secrets vault.",
        promptInjectionSuspected: false,
        fingerprint: "fp-stripe-123",
      },
      {
        type: "SQL Injection",
        severity: "HIGH",
        fileLocation: "src/db/user.ts",
        lineStart: 45,
        lineEnd: 46,
        codeSnippet: 'db.query("SELECT * FROM users WHERE id = " + id)',
        explanation: "Unsanitized user input concatenated to SQL query.",
        remediation: "Use parameterized queries.",
        promptInjectionSuspected: true,
        fingerprint: "fp-sqli-456",
      },
      {
        type: "Security Misconfiguration",
        severity: "medium",
        fileLocation: "next.config.ts",
        lineStart: 8,
        lineEnd: 10,
        codeSnippet: "poweredByHeader: true",
        explanation: "X-Powered-By header is enabled.",
        remediation: "Set poweredByHeader to false.",
        promptInjectionSuspected: false,
        fingerprint: "fp-misconfig-789",
      },
    ];

    // Simulate worker PullRequest upsert
    const prUpsertData = {
      where: { githubId: BigInt(rawPullRequest.id) },
      update: {
        title: rawPullRequest.title || `PR #${rawPullRequest.number}`,
        state: normalizePrStateEnum(rawPullRequest.state),
        status: normalizePrStatusEnum(rawDecision),
      },
      create: {
        githubId: BigInt(rawPullRequest.id),
        prNumber: rawPullRequest.number,
        title: rawPullRequest.title || `PR #${rawPullRequest.number}`,
        state: normalizePrStateEnum(rawPullRequest.state),
        status: normalizePrStatusEnum(rawDecision),
        repositoryId: "repo-123",
      },
    };

    expect(prUpsertData.create.state).toBe("OPEN");
    expect(prUpsertData.create.status).toBe("REVIEW_REQUIRED");
    expect(prUpsertData.update.state).toBe("OPEN");
    expect(prUpsertData.update.status).toBe("REVIEW_REQUIRED");

    // Simulate worker ScanResult create with Findings
    const scanResultData = {
      pullRequestId: "pr-db-id-1",
      riskScore: 25,
      policyDecision: normalizePolicyDecisionEnum(rawDecision),
      findings: {
        create: rawFindings.map((f) => ({
          type: normalizeFindingTypeEnum(f.type),
          severity: normalizeSeverity(f.severity),
          fileLocation: f.fileLocation,
          lineStart: f.lineStart,
          lineEnd: f.lineEnd,
          codeSnippet: f.codeSnippet,
          explanation: f.explanation,
          remediation: f.remediation,
          promptInjectionSuspected: Boolean(f.promptInjectionSuspected),
          fingerprint: f.fingerprint,
        })),
      },
    };

    expect(scanResultData.policyDecision).toBe("REVIEW");
    expect(scanResultData.findings.create).toHaveLength(3);

    // Finding 1: Secret
    expect(scanResultData.findings.create[0].type).toBe("SECRET");
    expect(scanResultData.findings.create[0].severity).toBe("CRITICAL");
    expect(scanResultData.findings.create[0].promptInjectionSuspected).toBe(false);

    // Finding 2: SQL Injection -> Vulnerability
    expect(scanResultData.findings.create[1].type).toBe("VULNERABILITY");
    expect(scanResultData.findings.create[1].severity).toBe("HIGH");
    expect(scanResultData.findings.create[1].promptInjectionSuspected).toBe(true);

    // Finding 3: Misconfig
    expect(scanResultData.findings.create[2].type).toBe("MISCONFIG");
    expect(scanResultData.findings.create[2].severity).toBe("MEDIUM");
  });
});
