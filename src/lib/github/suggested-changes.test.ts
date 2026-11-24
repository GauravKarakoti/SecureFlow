import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractSuggestedReplacement,
  formatSuggestionBlock,
  formatInlineCommentBody,
  resolveAnchorLine,
  buildInlineReviewComments,
  postSuggestedChangesReview,
  containsSecretValues,
  isAmbiguousFix,
  isMultiFileFix,
} from "./suggested-changes";
import { parseSecureFlowConfig, resolveSuggestionsConfig } from "@/lib/scanner/gate-config";
import type { ScanFinding } from "@/lib/armor/scanner";
import type { EnrichedScanFinding } from "@/lib/scanner/scan-persistence";

describe("GitHub Suggested Changes (#2005)", () => {
  describe("Candidate Replacement Extraction", () => {
    it("extracts clean code from explicit ```suggestion blocks", () => {
      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "SQL Injection",
        fileLocation: "src/db.ts",
        lineStart: 10,
        codeSnippet: "db.query(`SELECT * FROM users WHERE id = ${id}`);",
        remediation:
          "Use parameterized queries:\n```suggestion\ndb.query('SELECT * FROM users WHERE id = $1', [id]);\n```",
      };

      const replacement = extractSuggestedReplacement(finding);
      expect(replacement).toBe("db.query('SELECT * FROM users WHERE id = $1', [id]);");
    });

    it("extracts clean code from standard fenced code blocks", () => {
      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Hardcoded timeout",
        fileLocation: "src/client.ts",
        lineStart: 15,
        codeSnippet: "timeout: 1000",
        remediation: "Configure standard timeout:\n```typescript\ntimeout: DEFAULT_TIMEOUT_MS\n```",
      };

      const replacement = extractSuggestedReplacement(finding);
      expect(replacement).toBe("timeout: DEFAULT_TIMEOUT_MS");
    });

    it("extracts clean single-line code directly when no code block is used", () => {
      const finding: ScanFinding = {
        type: "Misconfig",
        severity: "HIGH",
        description: "Running as root",
        fileLocation: "Dockerfile",
        lineStart: 5,
        codeSnippet: "USER root",
        remediation: "USER 10001:10001",
      };

      const replacement = extractSuggestedReplacement(finding);
      expect(replacement).toBe("USER 10001:10001");
    });

    it("skips multi-line replacements exceeding the 5-line limit", () => {
      const longFix = Array.from({ length: 8 }, (_, i) => `line_${i + 1}();`).join("\n");
      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Large refactor",
        fileLocation: "src/refactor.ts",
        lineStart: 1,
        codeSnippet: "bad()",
        remediation: `\`\`\`typescript\n${longFix}\n\`\`\``,
      };

      expect(extractSuggestedReplacement(finding)).toBeNull();
    });

    it("skips ambiguous fixes (containing either/or, depending on, could also, etc.)", () => {
      expect(isAmbiguousFix("You could also use Redis, depending on your architecture.")).toBe(
        true,
      );
      expect(isAmbiguousFix("Consider either AES-GCM or ChaCha20-Poly1305.")).toBe(true);
      expect(isAmbiguousFix("For example, try rotating the key.")).toBe(true);
      expect(isAmbiguousFix("const clean = sanitize(input);")).toBe(false);

      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Insecure hashing",
        fileLocation: "src/auth.ts",
        lineStart: 20,
        codeSnippet: "crypto.createHash('md5')",
        remediation:
          "Depending on your requirements, consider using either SHA-256 or bcrypt:\n```js\ncrypto.createHash('sha256')\n```",
      };

      expect(extractSuggestedReplacement(finding)).toBeNull();
    });

    it("skips multi-file fixes", () => {
      expect(isMultiFileFix("Update auth.ts and also in config.json")).toBe(true);
      expect(isMultiFileFix("Modify both files across multiple files")).toBe(true);
      expect(isMultiFileFix("const a = 1;")).toBe(false);

      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Config mismatch",
        fileLocation: "src/auth.ts",
        lineStart: 12,
        codeSnippet: "loadConfig()",
        remediation:
          "Update `src/auth.ts` and also in `config.json`:\n```js\nloadConfig('auth')\n```",
      };

      expect(extractSuggestedReplacement(finding)).toBeNull();
    });

    it("never includes secret values or generates suggestions for Secret findings", () => {
      const secretFinding: ScanFinding = {
        type: "Secret",
        severity: "CRITICAL",
        description: "API key leaked",
        fileLocation: "src/keys.ts",
        lineStart: 3,
        codeSnippet: 'const key = "sk-12345678901234567890123456789012";',
        remediation: 'const key = "sk-NEWKEY12345678901234567890123456";',
      };

      expect(extractSuggestedReplacement(secretFinding)).toBeNull();

      const findingWithRedaction: ScanFinding = {
        type: "Misconfig",
        severity: "HIGH",
        description: "Token leaked",
        fileLocation: "src/api.ts",
        lineStart: 10,
        codeSnippet: 'const token = "foo";',
        remediation: 'const token = "ghp_1234[REDACTED]";',
      };

      expect(containsSecretValues('const token = "ghp_1234[REDACTED]";')).toBe(true);
      expect(extractSuggestedReplacement(findingWithRedaction)).toBeNull();
    });
  });

  describe("Formatting Suggestions", () => {
    it("formats suggested change code fence correctly", () => {
      const block = formatSuggestionBlock("const valid = true;");
      expect(block).toBe("```suggestion\nconst valid = true;\n```");
    });

    it("formats inline comment body including the suggestion block", () => {
      const finding: EnrichedScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Direct SQL expansion",
        fileLocation: "src/db.ts",
        lineStart: 10,
        codeSnippet: "query()",
        explanation: "SQL query uses direct string interpolation.",
        remediation: "Use parameterized queries.",
      };

      const body = formatInlineCommentBody(finding, "db.query('SELECT 1');");
      expect(body).toContain("**🟠 HIGH · Vulnerability**");
      expect(body).toContain("SQL query uses direct string interpolation.");
      expect(body).toContain("```suggestion\ndb.query('SELECT 1');\n```");
      expect(body).toContain(
        "<details>\n<summary><b>🛠️ View Remediation Suggestions</b></summary>",
      );
    });
  });

  describe("Diff Boundary Verification", () => {
    it("resolves anchor line when the finding line is inside the diff", () => {
      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Issue",
        fileLocation: "src/app.ts",
        lineStart: 15,
        codeSnippet: "bad()",
      };
      const commentable = new Set([10, 15, 20]);
      expect(resolveAnchorLine(finding, commentable)).toBe(15);
    });

    it("returns null when the finding line is outside the diff", () => {
      const finding: ScanFinding = {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Issue",
        fileLocation: "src/app.ts",
        lineStart: 99,
        codeSnippet: "bad()",
      };
      const commentable = new Set([10, 15, 20]);
      expect(resolveAnchorLine(finding, commentable)).toBeNull();
    });
  });

  describe("Opt-in and Per-PR Limits", () => {
    const commentableMap = new Map<string, Set<number>>([
      ["src/app.ts", new Set([10, 20, 30, 40])],
    ]);

    const findings: EnrichedScanFinding[] = [
      {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Issue 1",
        fileLocation: "src/app.ts",
        lineStart: 10,
        codeSnippet: "bad1()",
        remediation: "```suggestion\nfixed1()\n```",
      },
      {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Issue 2",
        fileLocation: "src/app.ts",
        lineStart: 20,
        codeSnippet: "bad2()",
        remediation: "```suggestion\nfixed2()\n```",
      },
      {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Issue 3",
        fileLocation: "src/app.ts",
        lineStart: 30,
        codeSnippet: "bad3()",
        remediation: "```suggestion\nfixed3()\n```",
      },
      {
        type: "Vulnerability",
        severity: "HIGH",
        description: "Issue 4 (outside diff)",
        fileLocation: "src/app.ts",
        lineStart: 999, // outside diff
        codeSnippet: "bad4()",
        remediation: "```suggestion\nfixed4()\n```",
      },
    ];

    it("is disabled by default (opt-in)", () => {
      const defaultConfig = resolveSuggestionsConfig(undefined);
      expect(defaultConfig.enabled).toBe(false);

      const result = buildInlineReviewComments(findings, commentableMap, {
        suggestionsConfig: defaultConfig,
      });

      // Inline comments are posted, but NONE have the ```suggestion block
      expect(result.suggestionsAppliedCount).toBe(0);
      result.inlineComments.forEach((c) => {
        expect(c.body).not.toContain("```suggestion");
      });
    });

    it("enforces the per-PR limit when enabled", () => {
      const config = { enabled: true, maxSuggestions: 2 };
      const result = buildInlineReviewComments(findings, commentableMap, {
        suggestionsConfig: config,
      });

      // Limit of 2 must be strictly respected
      expect(result.suggestionsAppliedCount).toBe(2);

      const commentsWithSuggestions = result.inlineComments.filter((c) =>
        c.body.includes("```suggestion"),
      );
      expect(commentsWithSuggestions.length).toBe(2);

      // Third comment is inside diff but limit was reached -> no suggestion block
      const thirdComment = result.inlineComments.find((c) => c.line === 30);
      expect(thirdComment?.body).not.toContain("```suggestion");

      // Finding on line 999 is outside diff -> in summaryFindings, not inlineComments
      expect(result.summaryFindings.length).toBe(1);
      expect(result.summaryFindings[0].lineStart).toBe(999);
    });

    it("parses suggestions config from .secureflow.json", () => {
      const configJson = JSON.stringify({
        suggestions: {
          enabled: true,
          limit: 3,
        },
      });

      const parsedGate = parseSecureFlowConfig(configJson);
      const suggestions = resolveSuggestionsConfig(parsedGate);
      expect(suggestions.enabled).toBe(true);
      expect(suggestions.maxSuggestions).toBe(3);
    });
  });

  describe("Mocked GitHub Client Integration (postSuggestedChangesReview)", () => {
    let mockCreateReview: ReturnType<typeof vi.fn>;
    let mockOctokit: any;

    beforeEach(() => {
      mockCreateReview = vi.fn().mockResolvedValue({
        data: { id: 12345, html_url: "https://github.com/org/repo/pull/1#pullrequestreview-12345" },
      });
      mockOctokit = {
        rest: {
          pulls: {
            createReview: mockCreateReview,
          },
        },
      };
    });

    it("posts inline review comments on the exact diff lines with suggestions", async () => {
      const comments = [
        {
          path: "src/server.ts",
          line: 42,
          body: "**🔴 HIGH · Vulnerability**\n\n```suggestion\napp.use(helmet());\n```",
        },
      ];

      const res = await postSuggestedChangesReview(mockOctokit, {
        owner: "acme",
        repo: "api",
        pullNumber: 7,
        commitId: "sha-123456",
        comments,
      });

      expect(res.success).toBe(true);
      expect(res.reviewId).toBe(12345);
      expect(mockCreateReview).toHaveBeenCalledTimes(1);
      expect(mockCreateReview).toHaveBeenCalledWith({
        owner: "acme",
        repo: "api",
        pull_number: 7,
        commit_id: "sha-123456",
        event: "COMMENT",
        body: expect.any(String),
        comments: [
          {
            path: "src/server.ts",
            line: 42,
            body: expect.stringContaining("```suggestion\napp.use(helmet());\n```"),
          },
        ],
      });
    });

    it("handles GitHub API rejection gracefully without throwing", async () => {
      mockCreateReview.mockRejectedValue(new Error("Validation failed: line is not part of diff"));

      const res = await postSuggestedChangesReview(mockOctokit, {
        owner: "acme",
        repo: "api",
        pullNumber: 7,
        comments: [{ path: "src/bad.ts", line: 99, body: "test" }],
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Validation failed");
    });
  });
});
