import { describe, it, expect, vi } from "vitest";
import {
  runDeterministicPrecheck,
  mergePrecheckWithLlmFindings,
  redactSecret,
  precheckFilePatch,
} from "@/lib/armor/precheck";
import type { ScanFinding } from "@/lib/armor/scanner";

describe("Deterministic Secret Pre-Scanner (#1592)", () => {
  // Criteria 1: Happy path - diff adds a line with a fake AWS key
  it("detects fake AWS access key in added line and redacts snippet", () => {
    const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,3 +1,4 @@
 import os from "os";
+const AWS_KEY = "AKIAIOSFODNN7EXAMPLE12";
 export default AWS_KEY;
`;
    // Note: AKIA + 16 alphanumeric characters
    const validAwsDiff = `--- a/config.ts
+++ b/config.ts
@@ -1,3 +1,4 @@
 import os from "os";
+const AWS_KEY = "AKIA1234567890ABCDEF";
 export default AWS_KEY;
`;
    const findings = runDeterministicPrecheck([{ filename: "config.ts", patch: validAwsDiff }]);

    expect(findings.length).toBe(1);
    const f = findings[0];
    expect(f.fileLocation).toBe("config.ts");
    expect(f.lineStart).toBe(2);
    expect(f.type).toBe("Secret");
    expect(f.severity).toBe("CRITICAL");
    expect(f.matchedSignatures).toContain("precheck-deterministic");
    // Verify secret is redacted: at most 4 chars followed by redaction label
    expect(f.codeSnippet).toContain("AKIA...[REDACTED]");
    expect(f.codeSnippet).not.toContain("AKIA1234567890ABCDEF");
  });

  // Criteria 1 (b): Detects GitHub tokens, Slack tokens, PEM private key, and generic high-entropy
  it("detects GitHub token in added line with proper redaction", () => {
    const patch = `@@ -0,0 +1 @@
+const GH_TOKEN = "ghp_123456789012345678901234567890123456";
`;
    const findings = runDeterministicPrecheck([{ filename: "auth.ts", patch }]);
    expect(findings.length).toBe(1);
    expect(findings[0].matchedSignatures).toContain("github-token");
    expect(findings[0].codeSnippet).toContain("ghp_...[REDACTED]");
    expect(findings[0].codeSnippet).not.toContain("123456789012345678901234567890123456");
  });

  it("detects Slack token in added line with proper redaction", () => {
    const patch = `@@ -0,0 +1 @@
+const SLACK_BOT = "xoxb-1234567890-abcdefghij";
`;
    const findings = runDeterministicPrecheck([{ filename: "bot.ts", patch }]);
    expect(findings.length).toBe(1);
    expect(findings[0].matchedSignatures).toContain("slack-token");
    expect(findings[0].codeSnippet).toContain("xoxb...[REDACTED]");
    expect(findings[0].codeSnippet).not.toContain("abcdefghij");
  });

  it("detects PEM private key header block", () => {
    const patch = `@@ -0,0 +1 @@
+const CERT = "-----BEGIN RSA PRIVATE KEY-----";
`;
    const findings = runDeterministicPrecheck([{ filename: "cert.ts", patch }]);
    expect(findings.length).toBe(1);
    expect(findings[0].matchedSignatures).toContain("pem-private-key");
    expect(findings[0].codeSnippet).toContain("-----BEGIN PRIVATE KEY [REDACTED]-----");
  });

  it("detects high-entropy generic secret assignment", () => {
    const patch = `@@ -0,0 +1 @@
+const api_key = "a9f8e7d6c5b4a3928172635489f0e1d2";
`;
    const findings = runDeterministicPrecheck([{ filename: "api.ts", patch }]);
    expect(findings.length).toBe(1);
    expect(findings[0].matchedSignatures).toContain("quoted-secret-assignment");
    expect(findings[0].codeSnippet).toContain("a9f8...[REDACTED]");
    expect(findings[0].codeSnippet).not.toContain("a9f8e7d6c5b4a3928172635489f0e1d2");
  });

  // Criteria 3: Edge cases - placeholder value, removed line, and non-executable file
  it("ignores removed lines (-) and context lines without '+'", () => {
    const patch = `@@ -1,3 +1,2 @@
-const OLD_AWS_KEY = "AKIA1234567890ABCDEF";
 const UNCHANGED = "AKIA9876543210FEDCBA";
`;
    const findings = runDeterministicPrecheck([{ filename: "safe.ts", patch }]);
    expect(findings.length).toBe(0);
  });

  it("ignores obvious placeholders and documentation samples", () => {
    const patch = `@@ -0,0 +1,3 @@
+const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
+const API_KEY = "YOUR_API_KEY_HERE_123456789";
+const SECRET = "placeholder-replace-me-123456";
`;
    const findings = runDeterministicPrecheck([{ filename: "env.example", patch }]);
    expect(findings.length).toBe(0);
  });

  it("respects non-executable / ignored files (.md, lockfiles, images)", () => {
    const patch = `@@ -0,0 +1 @@
+Here is an example key: AKIA1234567890ABCDEF
`;
    const findings = runDeterministicPrecheck([
      { filename: "README.md", patch },
      { filename: "package-lock.json", patch },
    ]);
    expect(findings.length).toBe(0);
  });

  // Criteria 4: Dedup - pre-scan and LLM report on the same file and line
  it("deduplicates findings when precheck and LLM report on the same file and line", () => {
    const precheckFindings: ScanFinding[] = [
      {
        type: "Secret",
        severity: "CRITICAL",
        description: "Deterministic pre-scan finding",
        fileLocation: "src/secret.ts",
        lineStart: 12,
        lineEnd: 12,
        codeSnippet: "const key = 'AKIA...[REDACTED]';",
        matchedSignatures: ["aws-access-key-id", "precheck-deterministic"],
      },
    ];

    const llmFindings: ScanFinding[] = [
      {
        type: "Hardcoded Credential",
        severity: "HIGH",
        description: "LLM detected secret",
        fileLocation: "src/secret.ts",
        lineStart: 12,
        lineEnd: 12,
        codeSnippet: "const key = 'AKIA1234567890ABCDEF';",
      },
      {
        type: "SQL Injection",
        severity: "HIGH",
        description: "Unsanitized query",
        fileLocation: "src/db.ts",
        lineStart: 45,
        lineEnd: 45,
        codeSnippet: "db.query(userQuery);",
      },
    ];

    const merged = mergePrecheckWithLlmFindings(precheckFindings, llmFindings);
    // Exactly 2 findings: 1 from secret.ts:12 (precheck version) and 1 from db.ts:45
    expect(merged.length).toBe(2);
    const secretFinding = merged.find((f) => f.fileLocation === "src/secret.ts");
    expect(secretFinding).toBeDefined();
    expect(secretFinding?.matchedSignatures).toContain("precheck-deterministic");
    expect(secretFinding?.codeSnippet).toContain("[REDACTED]");
  });

  // Criteria 5: Redaction helper verification
  it("never outputs more than the first 4 characters followed by mask", () => {
    const rawSecret = "supercalifragilisticexpialidocious_secret_12345";
    const redacted = redactSecret(rawSecret);
    expect(redacted).toBe("supe...[REDACTED]");
    expect(redacted).not.toContain("califragilistic");
  });
});
