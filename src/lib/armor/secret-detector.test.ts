import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockCreate } from "../../../__mocks__/groq-sdk";
import {
  detectSecretsInAddedLines,
  detectSecretsInPatch,
  detectSecretsInFiles,
  mergeFindings,
  maskSecretValue,
  maskSnippet,
  isPlaceholder,
  shannonEntropy,
} from "./secret-detector";
import { ArmorIQScanner } from "./scanner";

// #1517: synthetic fake key built at runtime so scanners do not flag this file.
// It is deliberately not the documented ...EXAMPLE key, which is now skipped.
const FAKE_AWS = "AKIA" + "Q7XM2PLKD93HTRWN";

describe("secret-detector unit tests (#1448)", () => {
  // 1. AWS access key ID
  it("detects AWS access key IDs in added lines", () => {
    const lines = [{ number: 10, content: `const AWS_KEY = '${FAKE_AWS}';` }];
    const findings = detectSecretsInAddedLines("config/aws.ts", lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("Secret");
    expect(findings[0].severity).toBe("CRITICAL");
    expect(findings[0].fileLocation).toBe("config/aws.ts");
    expect(findings[0].lineStart).toBe(10);
    expect(findings[0].codeSnippet).toContain("AKIA");
    expect(findings[0].codeSnippet).not.toContain(FAKE_AWS);
  });

  // 2. GitHub tokens
  it("detects GitHub tokens (ghp_ and github_pat_ format)", () => {
    const lines = [
      { number: 5, content: 'const ghpToken = "ghp_1234567890abcdef1234567890abcdef1234";' },
      {
        number: 6,
        content:
          'const patToken = "github_pat_11AAABBB111_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";',
      },
    ];
    const findings = detectSecretsInAddedLines("lib/github.ts", lines);
    expect(findings).toHaveLength(2);
    expect(findings[0].codeSnippet).toContain("ghp_12");
    expect(findings[0].codeSnippet).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");
    expect(findings[1].codeSnippet).toContain("github_pat_11");
  });

  // 3. Slack tokens
  it("detects Slack tokens (xoxb- format)", () => {
    const lines = [
      { number: 14, content: 'export const SLACK_BOT_TOKEN = "xoxb-1234567890-abcdef123456";' },
    ];
    const findings = detectSecretsInAddedLines("src/notifications.ts", lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("Secret");
    expect(findings[0].codeSnippet).toContain("xoxb-1");
    expect(findings[0].codeSnippet).not.toContain("xoxb-1234567890-abcdef123456");
  });

  // 4. PEM private key headers
  it("detects PEM private key headers with CRITICAL severity", () => {
    const lines = [{ number: 1, content: "-----BEGIN RSA PRIVATE KEY-----" }];
    const findings = detectSecretsInAddedLines("certs/server.key", lines);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("CRITICAL");
    expect(findings[0].codeSnippet).toContain("[MASKED]");
  });

  // 5. Quoted secret assignments
  it("detects generic quoted secret assignments with names containing secret/token/password/api_key", () => {
    const lines = [
      { number: 22, content: 'const database_password = "supersecretproductionpassword123!";' },
      { number: 23, content: 'const client_secret: "prod_oauth_secret_value_xyz987654321",' },
    ];
    const findings = detectSecretsInAddedLines("src/db.ts", lines);
    expect(findings).toHaveLength(2);
    expect(findings[0].lineStart).toBe(22);
    expect(findings[0].codeSnippet).not.toContain("supersecretproductionpassword123!");
    expect(findings[1].lineStart).toBe(23);
    expect(findings[1].codeSnippet).not.toContain("prod_oauth_secret_value_xyz987654321");
  });

  // 6. Edge: placeholder exclusions
  it("ignores placeholder values like YOUR_API_KEY_HERE, changeme, process.env, and mock prefixes", () => {
    const lines = [
      { number: 1, content: 'const API_KEY = "YOUR_API_KEY_HERE";' },
      { number: 2, content: 'const secret = "changeme";' },
      { number: 3, content: 'const db_password = "replace_me";' },
      { number: 4, content: 'const token = "mock_secret_token_placeholder_value";' },
      { number: 5, content: "const envSecret = process.env.DATABASE_PASSWORD;" },
    ];
    const findings = detectSecretsInAddedLines(".env.example", lines);
    expect(findings).toHaveLength(0);
  });

  // 7. Edge: not added lines (removed or unchanged lines)
  it("only detects secrets on added lines (+), ignoring removed (-) or context lines in diff patches", () => {
    const patch = [
      "@@ -10,4 +10,4 @@",
      " const unchanged = 'AKIA1111111111111111';",
      "-const oldToken = 'ghp_oldremovedtoken1234567890abcdef123';",
      "+const newSafe = process.env.GITHUB_TOKEN;",
      " contextLine();",
    ].join("\n");

    const findings = detectSecretsInPatch("src/auth.ts", patch);
    expect(findings).toHaveLength(0);
  });

  it("detects secrets added in unified diff hunks", () => {
    const patch = [
      "@@ -10,3 +10,4 @@",
      " contextLine();",
      `+const apiKey = '${FAKE_AWS}';`,
      " anotherContext();",
    ].join("\n");

    const findings = detectSecretsInPatch("src/auth.ts", patch);
    expect(findings).toHaveLength(1);
    expect(findings[0].lineStart).toBe(11);
    expect(findings[0].fileLocation).toBe("src/auth.ts");
    expect(findings[0].codeSnippet).not.toContain(FAKE_AWS);
  });

  // 8. Masking verification
  it("masks the middle of secret values retaining prefix and suffix", () => {
    const awsMasked = maskSecretValue("AKIAIOSFODNN7EXAMPLE");
    expect(awsMasked).toBe("AKIAI...MPLE");

    const ghpMasked = maskSecretValue("ghp_1234567890abcdef1234567890abcdef1234");
    expect(ghpMasked.startsWith("ghp_12")).toBe(true);
    expect(ghpMasked.endsWith("1234")).toBe(true);
    expect(ghpMasked).toContain("...");

    const pemMasked = maskSecretValue("-----BEGIN PRIVATE KEY-----");
    expect(pemMasked).toContain("[MASKED]");
  });

  // 9. Merging and deduplication
  it("merges deterministic and LLM findings, dropping duplicates on the same file and line", () => {
    const deterministic = [
      {
        type: "Secret",
        severity: "HIGH" as const,
        description: "Deterministic detection: GitHub Token",
        fileLocation: "src/auth.ts",
        codeSnippet: 'const token = "ghp_12...1234";',
        lineStart: 42,
        lineEnd: 42,
      },
    ];

    const llmFindings = [
      {
        type: "Secret",
        severity: "HIGH" as const,
        description: "LLM reported hardcoded credential",
        fileLocation: "src/auth.ts",
        codeSnippet: 'const token = "ghp_1234...";',
        lineStart: 42,
        lineEnd: 42,
      },
      {
        type: "Vulnerability",
        severity: "CRITICAL" as const,
        description: "SQL Injection",
        fileLocation: "src/db.ts",
        codeSnippet: "db.query(userInput);",
        lineStart: 88,
        lineEnd: 88,
      },
    ];

    const merged = mergeFindings(deterministic, llmFindings);
    expect(merged).toHaveLength(2);
    expect(merged[0].fileLocation).toBe("src/auth.ts");
    expect(merged[0].description).toContain("Deterministic detection");
    expect(merged[1].fileLocation).toBe("src/db.ts");
    expect(merged[1].description).toBe("SQL Injection");
  });
});

describe("ArmorIQScanner deterministic pre-scanner integration (#1448)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("completes scan and saves deterministic findings when Groq rejects or times out", async () => {
    // Mock Groq LLM failure
    mockCreate.mockRejectedValue(new Error("Groq API 503 Service Unavailable"));

    const scanner = new ArmorIQScanner();
    const files = [
      {
        filename: "src/credentials.ts",
        patch: [
          "@@ -1,2 +1,3 @@",
          " import fs from 'fs';",
          "+const token = 'ghp_1234567890abcdef1234567890abcdef1234';",
        ].join("\n"),
      },
    ];

    // Must NOT throw unhandled error when Groq is down
    const findings = await scanner.scanPullRequest(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("Secret");
    expect(findings[0].fileLocation).toBe("src/credentials.ts");
    expect(findings[0].lineStart).toBe(2);
    expect(findings[0].codeSnippet).not.toContain("ghp_1234567890abcdef1234567890abcdef1234");
  });

  it("handles diff with multiple secret families and avoids duplicates with LLM findings", async () => {
    // Mock Groq LLM returning finding for same file and line
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  type: "Secret",
                  severity: "HIGH",
                  description: "LLM finding duplicate",
                  fileLocation: "src/aws.ts",
                  codeSnippet: `const awsKey = '${FAKE_AWS}';`,
                  lineStart: 3,
                },
              ],
            }),
          },
        },
      ],
    });

    const scanner = new ArmorIQScanner();
    const files = [
      {
        filename: "src/aws.ts",
        patch: [
          "@@ -1,2 +1,4 @@",
          " import AWS from 'aws-sdk';",
          `+const awsKey = '${FAKE_AWS}';`,
          "+const pem = '-----BEGIN RSA PRIVATE KEY-----';",
        ].join("\n"),
      },
    ];

    const findings = await scanner.scanPullRequest(files);
    // #1517: both deterministic findings are CRITICAL now, and the LLM finding
    // on line 3 duplicates the PEM finding, so it is dropped.
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "CRITICAL")).toBe(true);
    expect(findings.map((f) => f.lineStart).sort()).toEqual([2, 3]);
    expect(findings.map((f) => f.description)).not.toContain("LLM finding duplicate");
  });

  it("completes cleanly with zero findings for clean diffs", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({ findings: [] }),
          },
        },
      ],
    });

    const scanner = new ArmorIQScanner();
    const files = [
      {
        filename: "src/math.ts",
        patch: [
          "@@ -1,2 +1,3 @@",
          " function add(a: number, b: number) {",
          "+  return a + b;",
          " }",
        ].join("\n"),
      },
    ];

    const findings = await scanner.scanPullRequest(files);
    expect(findings).toHaveLength(0);
  });
});
