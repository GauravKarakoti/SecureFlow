import { describe, expect, it } from "vitest";
import {
  applyInlineSuppression,
  extractDirectivesFromPatch,
  sanitizeSuppressionReason,
  INLINE_DIRECTIVE_REGEX,
} from "./inline-suppression";
import type { ScanFinding, FileChange } from "./scanner";
import { renderScanReportSummary } from "@/lib/github/scan-report";

describe("INLINE_DIRECTIVE_REGEX", () => {
  it("matches // secureflow-ignore: <reason>", () => {
    const match = "// secureflow-ignore: test mock".match(INLINE_DIRECTIVE_REGEX);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("test mock");
  });

  it("matches # secureflow-ignore: <reason>", () => {
    const match = "# secureflow-ignore: python mock credential".match(INLINE_DIRECTIVE_REGEX);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("python mock credential");
  });

  it("matches trailing inline comment after code", () => {
    const match = 'const key = "test"; // secureflow-ignore: dummy key'.match(
      INLINE_DIRECTIVE_REGEX,
    );
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("dummy key");
  });

  it("matches directive with empty reason", () => {
    const match = "// secureflow-ignore:".match(INLINE_DIRECTIVE_REGEX);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("");
  });

  it("matches directive without colon or reason", () => {
    const match = "// secureflow-ignore".match(INLINE_DIRECTIVE_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]?.trim() ?? "").toBe("");
  });

  it("is case-insensitive", () => {
    const match = "// SECUREFLOW-IGNORE: UPPERCASE REASON".match(INLINE_DIRECTIVE_REGEX);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("UPPERCASE REASON");
  });
});

describe("sanitizeSuppressionReason", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeSuppressionReason("")).toBe("");
  });

  it("caps input at 200 characters", () => {
    const longString = "A".repeat(500);
    const sanitized = sanitizeSuppressionReason(longString);
    expect(sanitized.length).toBeLessThanOrEqual(200);
    expect(sanitized).toBe("A".repeat(200));
  });

  it("disarms @mention notifications with zero-width space", () => {
    const input = "Reported to @octocat and @security-team for triage";
    const sanitized = sanitizeSuppressionReason(input);
    expect(sanitized).toContain("@\u200Boctocat");
    expect(sanitized).toContain("@\u200Bsecurity-team");
    expect(sanitized).not.toContain("@octocat");
  });

  it("escapes backticks to prevent markdown breakout", () => {
    const input = "Contains `code` snippet and ```fence``` block";
    const sanitized = sanitizeSuppressionReason(input);
    expect(sanitized).toContain("\\`code\\`");
    expect(sanitized).toContain("\\`\\`\\`fence\\`\\`\\`");
    expect(sanitized).not.toContain("`code`");
  });

  it("escapes HTML angle brackets", () => {
    const input = "<script>alert(1)</script>";
    const sanitized = sanitizeSuppressionReason(input);
    expect(sanitized).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("masks embedded secrets using existing secret-masking rules", () => {
    const input = "Legacy key sk-ant-api03-abcdef1234567890abcdef1234567890 used in sandbox";
    const sanitized = sanitizeSuppressionReason(input);
    expect(sanitized).toContain("[REDACTED_BY_THE_PROFESSOR]");
    expect(sanitized).not.toContain("sk-ant-api03-");
  });

  it("normalizes newlines to spaces", () => {
    const input = "Line one\r\nLine two\nLine three";
    const sanitized = sanitizeSuppressionReason(input);
    expect(sanitized).toBe("Line one Line two Line three");
  });
});

describe("extractDirectivesFromPatch", () => {
  it("returns empty array for empty patch", () => {
    expect(extractDirectivesFromPatch("")).toEqual([]);
  });

  it("extracts valid directives with line numbers from patch", () => {
    const patch = [
      "@@ -10,4 +10,5 @@",
      " const a = 1;",
      "+// secureflow-ignore: false positive in testing",
      "+const secret = 'abc';",
      " const b = 2;",
    ].join("\n");

    const directives = extractDirectivesFromPatch(patch, "src/config.ts");
    expect(directives).toHaveLength(1);
    expect(directives[0]).toEqual({
      file: "src/config.ts",
      line: 11,
      rawReason: "false positive in testing",
      hasReason: true,
    });
  });

  it("extracts directives with missing reason as hasReason: false", () => {
    const patch = [
      "@@ -10,3 +10,4 @@",
      " const a = 1;",
      "+// secureflow-ignore:",
      "+const secret = 'abc';",
    ].join("\n");

    const directives = extractDirectivesFromPatch(patch, "src/config.ts");
    expect(directives).toHaveLength(1);
    expect(directives[0].hasReason).toBe(false);
    expect(directives[0].rawReason).toBe("");
  });
});

describe("applyInlineSuppression", () => {
  const createFinding = (overrides: Partial<ScanFinding> = {}): ScanFinding => ({
    type: "HARDCODED_SECRET",
    severity: "HIGH",
    description: "Hardcoded credential detected.",
    fileLocation: "src/auth.ts",
    codeSnippet: 'const token = "sk-live-123456";',
    lineStart: 12,
    lineEnd: 12,
    ...overrides,
  });

  it("happy path: suppresses HIGH finding with valid directive on lineStart", () => {
    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,4 @@",
          " const a = 1;",
          '+const token = "sk-live-123456"; // secureflow-ignore: dummy key for unit testing',
          " const b = 2;",
        ].join("\n"),
      },
    ];

    const finding = createFinding({ lineStart: 11, severity: "HIGH" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].fileLocation).toBe("src/auth.ts");
    expect(result.suppressedFindings[0].line).toBe(11);
    expect(result.suppressedFindings[0].reason).toBe("dummy key for unit testing");
    expect(result.suppressedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
  });

  it("happy path: suppresses HIGH finding with directive on immediately preceding line (lineStart - 1)", () => {
    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,5 @@",
          " const a = 1;",
          "+// secureflow-ignore: verified fixture credential",
          '+const token = "sk-live-123456";',
          " const b = 2;",
        ].join("\n"),
      },
    ];

    const finding = createFinding({ lineStart: 12, severity: "HIGH" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].line).toBe(12);
    expect(result.suppressedFindings[0].reason).toBe("verified fixture credential");
  });

  it("supports python comments (# secureflow-ignore: reason)", () => {
    const files: FileChange[] = [
      {
        filename: "services/client.py",
        patch: [
          "@@ -5,3 +5,5 @@",
          " import os",
          "+# secureflow-ignore: local development placeholder",
          '+API_KEY = "test_key_123"',
          " def connect():",
        ].join("\n"),
      },
    ];

    const finding = createFinding({
      fileLocation: "services/client.py",
      lineStart: 7,
      severity: "MEDIUM",
    });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].reason).toBe("local development placeholder");
  });

  it("edge (a): directive without a reason does not suppress finding and records rejection", () => {
    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,5 @@",
          " const a = 1;",
          "+// secureflow-ignore:",
          '+const token = "sk-live-123456";',
          " const b = 2;",
        ].join("\n"),
      },
    ];

    const finding = createFinding({ lineStart: 12, severity: "HIGH" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0]).toBe(finding);
    expect(result.suppressedFindings).toHaveLength(0);
    expect(result.rejectedSuppressions).toHaveLength(1);
    expect(result.rejectedSuppressions[0].reason).toContain("directive requires a stated reason");
    expect(result.rejectedSuppressions[0].line).toBe(11);
  });

  it("edge (b): directive on a CRITICAL finding is rejected and finding remains active", () => {
    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,5 @@",
          " const a = 1;",
          "+// secureflow-ignore: intentional bypass for legacy client",
          '+const rootPassword = "unhashed_production_password";',
          " const b = 2;",
        ].join("\n"),
      },
    ];

    const finding = createFinding({ lineStart: 12, severity: "CRITICAL" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0].severity).toBe("CRITICAL");
    expect(result.suppressedFindings).toHaveLength(0);
    expect(result.rejectedSuppressions).toHaveLength(1);
    expect(result.rejectedSuppressions[0].reason).toContain(
      "inline suppression of CRITICAL findings is not permitted",
    );
  });

  it("edge (c): directive two lines away from finding does NOT suppress finding", () => {
    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,6 @@",
          "+// secureflow-ignore: false positive on line 11",
          " const intermediate = computeValue();",
          " const secondary = computeValue();",
          '+const token = "sk-live-123456";',
          " const b = 2;",
        ].join("\n"),
      },
    ];

    // Directive is at line 10. Intermediate at line 11. Secondary at line 12. Token at line 13.
    // Line 13 is three lines away from line 10.
    const finding = createFinding({ lineStart: 13, severity: "HIGH" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0]).toBe(finding);
    expect(result.suppressedFindings).toHaveLength(0);
  });

  it("edge (d): hostile reason is sanitized (capped at 200 chars, @mention disarmed, backticks escaped, secrets masked)", () => {
    const secret = "sk-ant-api03-abcdef1234567890abcdef1234567890";
    const hostileReason =
      `@octocat @admin \`\`\`rm -rf /\`\`\` <script>alert(1)</script> ` +
      secret +
      " " +
      "Z".repeat(500);

    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,4 @@",
          " const a = 1;",
          `+const key = "test"; // secureflow-ignore: ${hostileReason}`,
          " const b = 2;",
        ].join("\n"),
      },
    ];

    const finding = createFinding({ lineStart: 11, severity: "HIGH" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);

    const sanitizedReason = result.suppressedFindings[0].reason;
    // Capped length
    expect(sanitizedReason.length).toBeLessThanOrEqual(250); // with mask expansion
    // Mentions disarmed
    expect(sanitizedReason).toContain("@\u200Boctocat");
    expect(sanitizedReason).toContain("@\u200Badmin");
    expect(sanitizedReason).not.toContain("@octocat ");
    // Backticks escaped
    expect(sanitizedReason).toContain("\\`\\`\\`");
    // HTML escaped
    expect(sanitizedReason).toContain("&lt;script&gt;");
    // Secrets masked
    expect(sanitizedReason).toContain("[REDACTED_BY_THE_PROFESSOR]");
    expect(sanitizedReason).not.toContain(secret);
  });

  it("preserves untouched findings when diff has no directives", () => {
    const files: FileChange[] = [
      {
        filename: "src/auth.ts",
        patch: [
          "@@ -10,3 +10,4 @@",
          " const a = 1;",
          '+const token = "sk-live-123456";',
          " const b = 2;",
        ].join("\n"),
      },
    ];

    const finding = createFinding({ lineStart: 11, severity: "HIGH" });
    const result = applyInlineSuppression([finding], files);

    expect(result.activeFindings).toHaveLength(1);
    expect(result.suppressedFindings).toHaveLength(0);
    expect(result.rejectedSuppressions).toHaveLength(0);
  });
});

describe("Complete 4-finding fixture demo and scan report rendering", () => {
  it("processes fixture diff with 4 findings: valid, no reason, CRITICAL, and hostile reason", () => {
    const patch = [
      "@@ -1,15 +1,21 @@",
      " // Module header",
      "+// secureflow-ignore: false positive in test mock",
      '+const testMockKey = "sk-mock-key-12345";',
      "+",
      "+// secureflow-ignore:",
      '+const unreasonedKey = "sk-unreasoned-12345";',
      "+",
      "+// secureflow-ignore: critical bypass attempt",
      '+const criticalMasterKey = "prod_master_db_root_password";',
      "+",
      '+const hostileKey = "sk-hostile-12345"; // secureflow-ignore: pinging @security-team with ```injection``` and sk-proj-1234567890abcdef1234567890abcdef123456',
      " export default {};",
    ].join("\n");

    const files: FileChange[] = [{ filename: "src/credentials.ts", patch }];

    const f1: ScanFinding = {
      type: "MOCK_SECRET",
      severity: "HIGH",
      description: "Test mock key found.",
      fileLocation: "src/credentials.ts",
      codeSnippet: "const testMockKey",
      lineStart: 3,
      lineEnd: 3,
    };

    const f2: ScanFinding = {
      type: "UNREASONED_SECRET",
      severity: "MEDIUM",
      description: "Secret with blank suppression directive.",
      fileLocation: "src/credentials.ts",
      codeSnippet: "const unreasonedKey",
      lineStart: 6,
      lineEnd: 6,
    };

    const f3: ScanFinding = {
      type: "CRITICAL_DATABASE_KEY",
      severity: "CRITICAL",
      description: "Root master database credentials in source.",
      fileLocation: "src/credentials.ts",
      codeSnippet: "const criticalMasterKey",
      lineStart: 9,
      lineEnd: 9,
    };

    const f4: ScanFinding = {
      type: "HOSTILE_REASON_SECRET",
      severity: "HIGH",
      description: "Secret with hostile suppression reason.",
      fileLocation: "src/credentials.ts",
      codeSnippet: "const hostileKey",
      lineStart: 11,
      lineEnd: 11,
    };

    const allFindings = [f1, f2, f3, f4];
    const result = applyInlineSuppression(allFindings, files);

    // Verified outcome:
    // f1 (valid): suppressed
    // f2 (no reason): stays in active findings, rejected recorded
    // f3 (CRITICAL): stays in active findings, rejected recorded
    // f4 (hostile): suppressed safely
    expect(result.activeFindings).toHaveLength(2);
    expect(result.activeFindings.map((f) => f.type)).toEqual([
      "UNREASONED_SECRET",
      "CRITICAL_DATABASE_KEY",
    ]);

    expect(result.suppressedFindings).toHaveLength(2);
    expect(result.suppressedFindings.map((s) => s.type)).toEqual([
      "MOCK_SECRET",
      "HOSTILE_REASON_SECRET",
    ]);

    expect(result.rejectedSuppressions).toHaveLength(2);
    expect(result.rejectedSuppressions.map((r) => r.findingType)).toEqual([
      "UNREASONED_SECRET",
      "CRITICAL_DATABASE_KEY",
    ]);

    // Now render the scan report summary
    const report = renderScanReportSummary({
      findings: result.activeFindings.map((f) => ({
        severity: f.severity,
        type: f.type,
        fileLocation: f.fileLocation,
        explanation: f.description,
        remediation: "Revoke and move to environment variable.",
      })),
      totalFindings: allFindings.length,
      inlineCount: 0,
      suppressedFindings: result.suppressedFindings,
      rejectedSuppressions: result.rejectedSuppressions,
    });

    // Verify report contents
    expect(report).toContain("### 🛡️ SecureFlow AI Security Report");
    expect(report).toContain("Detected **4** potential issues");
    expect(report).toContain("🔕 **2** finding(s) suppressed via inline directives.");
    expect(report).toContain("⚠️ **2** inline suppression directive(s) rejected or ignored.");

    // Active findings rendered
    expect(report).toContain("UNREASONED_SECRET");
    expect(report).toContain("CRITICAL_DATABASE_KEY");

    // Suppressed section rendered
    expect(report).toContain("### 🔕 Suppressed Findings (2)");
    expect(report).toContain("MOCK_SECRET");
    expect(report).toContain("HOSTILE_REASON_SECRET");
    expect(report).toContain("false positive in test mock");

    // Rejected section rendered
    expect(report).toContain("### ⚠️ Rejected / Ignored Suppressions (2)");
    expect(report).toContain("directive requires a stated reason");
    expect(report).toContain("inline suppression of CRITICAL findings is not permitted");

    // Hostile reason rendered safely in report
    expect(report).toContain("@\u200Bsecurity-team");
    expect(report).not.toContain("@security-team ");
    expect(report).toContain("\\`\\`\\`injection\\`\\`\\`");
    expect(report).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });
});

describe("Expiring suppressions (#1685)", () => {
  const finding = (overrides: Partial<ScanFinding> = {}): ScanFinding => ({
    type: "HIGH_ENTROPY_TOKEN",
    severity: "HIGH" as Severity,
    description: "High entropy token detected in config.",
    fileLocation: "src/auth.ts",
    codeSnippet: 'const token = "mock-high-entropy-token";',
    lineStart: 12,
    lineEnd: 12,
    ...overrides,
  });

  const makePatch = (
    directiveComment: string,
    lineContent: string = 'const token = "mock-high-entropy-token";',
  ) => ["@@ -10,3 +10,4 @@", " const a = 1;", `+${directiveComment}`, `+${lineContent}`].join("\n");

  it("Case 1: Happy path - HIGH finding, directive with a future expiry is suppressed and expiry appears in report", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");
    const patch = makePatch("// secureflow-ignore[expires=2026-12-31]: temporary test mock token");
    const file: FileChange = { filename: "src/auth.ts", patch };

    const result = applyInlineSuppression([finding()], [file], { now: fixedNow });

    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].expires).toBe("2026-12-31");
    expect(result.suppressedFindings[0].reason).toBe("temporary test mock token");
    expect(result.rejectedSuppressions).toHaveLength(0);

    const report = renderScanReportSummary({
      findings: [],
      totalFindings: 1,
      inlineCount: 0,
      suppressedFindings: result.suppressedFindings,
      rejectedSuppressions: result.rejectedSuppressions,
    });

    expect(report).toContain("🔕 **1** finding(s) suppressed via inline directives.");
    expect(report).toContain("HIGH_ENTROPY_TOKEN");
    expect(report).toContain("reason: temporary test mock token (expires 2026-12-31)");
  });

  it("Case 2: Expired - directive with past expiry keeps finding active and states expiry date in rejection", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");
    const patch = makePatch("// secureflow-ignore[expires=2026-01-15]: legacy temporary exception");
    const file: FileChange = { filename: "src/auth.ts", patch };

    const result = applyInlineSuppression([finding()], [file], { now: fixedNow });

    expect(result.activeFindings).toHaveLength(1);
    expect(result.suppressedFindings).toHaveLength(0);
    expect(result.rejectedSuppressions).toHaveLength(1);
    expect(result.rejectedSuppressions[0].reason).toContain("Suppression expired on 2026-01-15");

    const report = renderScanReportSummary({
      findings: [finding()],
      totalFindings: 1,
      inlineCount: 0,
      suppressedFindings: result.suppressedFindings,
      rejectedSuppressions: result.rejectedSuppressions,
    });

    expect(report).toContain("⚠️ **1** inline suppression directive(s) rejected or ignored.");
    expect(report).toContain("Suppression expired on 2026-01-15");
  });

  it("Case 3: Boundary - honoured through whole expiry date in UTC, then expired from next UTC day onward", () => {
    const patch = makePatch("# secureflow-ignore[expires=2026-06-15]: python pipeline mock");
    const file: FileChange = { filename: "src/auth.ts", patch };

    // During the expiry day at 23:59:59.000 UTC
    const sameDayBeforeMidnight = new Date("2026-06-15T23:59:59.000Z");
    const resultActive = applyInlineSuppression([finding()], [file], {
      now: sameDayBeforeMidnight,
    });
    expect(resultActive.activeFindings).toHaveLength(0);
    expect(resultActive.suppressedFindings).toHaveLength(1);
    expect(resultActive.rejectedSuppressions).toHaveLength(0);

    // One second into the next UTC day (2026-06-16T00:00:00.001Z)
    const nextDayUtc = new Date("2026-06-16T00:00:00.001Z");
    const resultExpired = applyInlineSuppression([finding()], [file], { now: nextDayUtc });
    expect(resultExpired.activeFindings).toHaveLength(1);
    expect(resultExpired.suppressedFindings).toHaveLength(0);
    expect(resultExpired.rejectedSuppressions).toHaveLength(1);
    expect(resultExpired.rejectedSuppressions[0].reason).toBe("Suppression expired on 2026-06-15");
  });

  it("Case 4: Failure - invalid calendar dates (2026-02-31, 2026-13-45) and relative strings (tomorrow) are ignored without throwing", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");

    const invalidDates = ["2026-02-31", "2026-13-45", "tomorrow", "2026/06/15", "invalid-date"];

    for (const invalidDate of invalidDates) {
      const patch = makePatch(`// secureflow-ignore[expires=${invalidDate}]: invalid date test`);
      const file: FileChange = { filename: "src/auth.ts", patch };

      expect(() => {
        const result = applyInlineSuppression([finding()], [file], { now: fixedNow });
        expect(result.activeFindings).toHaveLength(1);
        expect(result.suppressedFindings).toHaveLength(0);
        expect(result.rejectedSuppressions).toHaveLength(1);
        expect(result.rejectedSuppressions[0].reason).toContain(
          `Suppression ignored: invalid expiry date "${invalidDate}" (must be YYYY-MM-DD)`,
        );
      }).not.toThrow();
    }
  });

  it("Case 5: Regression - directives without [expires=...] continue to behave without expiration", () => {
    const farFuture = new Date("2035-01-01T00:00:00Z");
    const patch = makePatch("// secureflow-ignore: timeless acceptable exception");
    const file: FileChange = { filename: "src/auth.ts", patch };

    const result = applyInlineSuppression([finding()], [file], { now: farFuture });

    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].expires).toBeUndefined();
    expect(result.suppressedFindings[0].reason).toBe("timeless acceptable exception");
  });

  it("Case 6: Complete fixture demo with four directives (future, expired, boundary, malformed) and report rendering", () => {
    const fixedNow = new Date("2026-06-15T12:00:00Z");

    const patch = [
      "@@ -10,12 +10,16 @@",
      " const init = true;",
      "+// secureflow-ignore[expires=2026-12-31]: future valid suppression",
      "+const key1 = 'future-secret';",
      "+// secureflow-ignore[expires=2026-01-01]: past expired suppression",
      "+const key2 = 'expired-secret';",
      "+# secureflow-ignore[expires=2026-06-15]: boundary active today",
      "+const key3 = 'boundary-secret';",
      "+// secureflow-ignore[expires=tomorrow]: malformed relative date",
      "+const key4 = 'malformed-secret';",
    ].join("\n");

    const file: FileChange = { filename: "src/app/secrets.ts", patch };

    const f1 = finding({
      type: "FUTURE_KEY",
      lineStart: 12,
      lineEnd: 12,
      fileLocation: "src/app/secrets.ts",
    });
    const f2 = finding({
      type: "EXPIRED_KEY",
      lineStart: 14,
      lineEnd: 14,
      fileLocation: "src/app/secrets.ts",
    });
    const f3 = finding({
      type: "BOUNDARY_KEY",
      lineStart: 16,
      lineEnd: 16,
      fileLocation: "src/app/secrets.ts",
    });
    const f4 = finding({
      type: "MALFORMED_KEY",
      lineStart: 18,
      lineEnd: 18,
      fileLocation: "src/app/secrets.ts",
    });

    const result = applyInlineSuppression([f1, f2, f3, f4], [file], { now: fixedNow });

    // 2 active (expired + malformed), 2 suppressed (future + boundary active today)
    expect(result.activeFindings).toHaveLength(2);
    expect(result.activeFindings.map((f) => f.type)).toEqual(["EXPIRED_KEY", "MALFORMED_KEY"]);

    expect(result.suppressedFindings).toHaveLength(2);
    expect(result.suppressedFindings.map((s) => s.type)).toEqual(["FUTURE_KEY", "BOUNDARY_KEY"]);

    expect(result.rejectedSuppressions).toHaveLength(2);
    expect(result.rejectedSuppressions[0].reason).toContain("Suppression expired on 2026-01-01");
    expect(result.rejectedSuppressions[1].reason).toContain('invalid expiry date "tomorrow"');

    const report = renderScanReportSummary({
      findings: result.activeFindings.map((f) => ({
        severity: f.severity,
        type: f.type,
        fileLocation: f.fileLocation,
        explanation: f.description,
      })),
      totalFindings: 4,
      inlineCount: 0,
      suppressedFindings: result.suppressedFindings,
      rejectedSuppressions: result.rejectedSuppressions,
    });

    // Verify rendered PR comment output
    expect(report).toContain("🔕 **2** finding(s) suppressed via inline directives.");
    expect(report).toContain("⚠️ **2** inline suppression directive(s) rejected or ignored.");
    expect(report).toContain("reason: future valid suppression (expires 2026-12-31)");
    expect(report).toContain("reason: boundary active today (expires 2026-06-15)");
    expect(report).toContain("Suppression expired on 2026-01-01");
    expect(report).toContain('invalid expiry date "tomorrow"');
  });

  it("handles whitespace variations inside [expires=...] attributes gracefully", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");
    const patch = makePatch("// secureflow-ignore [ expires = 2026-12-31 ] : spaced expiry test");
    const file: FileChange = { filename: "src/auth.ts", patch };

    const result = applyInlineSuppression([finding()], [file], { now: fixedNow });
    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].expires).toBe("2026-12-31");
    expect(result.suppressedFindings[0].reason).toBe("spaced expiry test");
  });

  it("handles directives placed on lineStart directly versus lineStart - 1 with expiry", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");
    const patch = [
      "@@ -10,4 +10,6 @@",
      " const before = 1;",
      "+const findingA = 'direct-line'; // secureflow-ignore[expires=2026-12-31]: direct line match",
      "+// secureflow-ignore[expires=2026-12-31]: preceding line match",
      "+const findingB = 'preceding-line';",
      " const after = 2;",
    ].join("\n");

    const file: FileChange = { filename: "src/auth.ts", patch };
    const fA = finding({ lineStart: 11, lineEnd: 11, codeSnippet: "findingA" });
    const fB = finding({ lineStart: 13, lineEnd: 13, codeSnippet: "findingB" });

    const result = applyInlineSuppression([fA, fB], [file], { now: fixedNow });
    expect(result.activeFindings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(2);
    expect(result.suppressedFindings[0].expires).toBe("2026-12-31");
    expect(result.suppressedFindings[1].expires).toBe("2026-12-31");
  });
});
