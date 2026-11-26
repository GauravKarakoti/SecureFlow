import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const mockGenerate = vi.fn();

vi.mock("@/ai/genkit", () => ({
  getAiInstance: vi.fn(() => ({ generate: mockGenerate })),
  getDefaultModelRef: vi.fn(() => "mock-model"),
}));

import { generateRemediationPatch } from "./generate-remediation-patch";

describe("generateRemediationPatch with Automated Patch Verification (#1977)", () => {
  let workspaceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-patch-ai-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("verifies a valid patch: applies cleanly, parses syntax, marks verified as ready fix, and leaves workspace unchanged", async () => {
    const realFilePath = path.join(workspaceDir, "db.ts");
    const originalContent = "const query = 'SELECT * FROM users WHERE id = ' + userId;\n";
    fs.writeFileSync(realFilePath, originalContent, "utf8");
    const beforeStat = fs.statSync(realFilePath);

    const validPatch =
      "--- a/db.ts\n+++ b/db.ts\n@@ -1 +1 @@\n-const query = 'SELECT * FROM users WHERE id = ' + userId;\n+const query = 'SELECT * FROM users WHERE id = ?';\n";

    mockGenerate.mockResolvedValueOnce({
      output: {
        patchDiff: validPatch,
        explanation: "Replaced string concatenation with parameterized query.",
      },
    });

    const result = await generateRemediationPatch({
      filePath: realFilePath,
      findingDescription: "SQL injection",
      vulnerableCode: originalContent,
      originalContent,
    });

    // Marked as verified ready fix
    expect(result.verified).toBe(true);
    expect(result.readyFix).toBe(true);
    expect(result.patchDiff).toBe(validPatch);
    expect(result.explanation).toBe("Replaced string concatenation with parameterized query.");
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // Workspace safety: real file untouched
    const afterStat = fs.statSync(realFilePath);
    expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);
  });

  it("handles a failing patch: retries once with feedback, and if it still fails shows finding without patch and short note", async () => {
    const realFilePath = path.join(workspaceDir, "auth.ts");
    const originalContent =
      "function authenticateUser(token: string) {\n  return token === 'secret';\n}\n";
    fs.writeFileSync(realFilePath, originalContent, "utf8");
    const beforeStat = fs.statSync(realFilePath);

    // Initial failing patch: context mismatch
    const badPatch1 =
      "--- a/auth.ts\n+++ b/auth.ts\n@@ -1,3 +1,3 @@\n function completelyDifferentCode() {\n-  return false;\n+  return true;\n}\n";

    // Retry patch: also fails (removal mismatch)
    const badPatch2 =
      "--- a/auth.ts\n+++ b/auth.ts\n@@ -1,3 +1,3 @@\n function authenticateUser(token: string) {\n-  return wrongLine;\n+  return safeCompare(token, expected);\n}\n";

    mockGenerate
      .mockResolvedValueOnce({
        output: {
          patchDiff: badPatch1,
          explanation: "Attempt 1 fix.",
        },
      })
      .mockResolvedValueOnce({
        output: {
          patchDiff: badPatch2,
          explanation: "Attempt 2 fix.",
        },
      });

    const result = await generateRemediationPatch({
      filePath: realFilePath,
      findingDescription: "Hardcoded secret comparison",
      vulnerableCode: originalContent,
      originalContent,
    });

    // Verification retried once with feedback
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const retryCallArgs = mockGenerate.mock.calls[1][0];
    expect(retryCallArgs.prompt).toContain(
      "IMPORTANT: The previous patch failed automated verification",
    );
    expect(retryCallArgs.prompt).toContain("Patch context mismatch");

    // ACCEPTANCE CRITERIA:
    // Patches that do not apply are never shown as ready fixes
    expect(result.verified).toBe(false);
    expect(result.readyFix).toBe(false);
    expect(result.patchDiff).toBe(""); // Finding shown without patch
    expect(result.note).toMatch(/Patch verification failed.*No ready fix available/);

    // Workspace safety: real file untouched
    const afterStat = fs.statSync(realFilePath);
    expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("handles a syntax-breaking patch: detects syntax parse error, retries once, and falls back to note without ready fix", async () => {
    const realFilePath = path.join(workspaceDir, "api.ts");
    const originalContent = "export const rateLimit = 100;\n";
    fs.writeFileSync(realFilePath, originalContent, "utf8");
    const beforeStat = fs.statSync(realFilePath);

    // Initial patch applies cleanly but breaks syntax
    const syntaxBrokenPatch1 =
      "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-export const rateLimit = 100;\n+export const rateLimit = ;\n";

    // Retry patch also breaks syntax
    const syntaxBrokenPatch2 =
      "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-export const rateLimit = 100;\n+export const rateLimit = { invalid syntax here ;\n";

    mockGenerate
      .mockResolvedValueOnce({
        output: {
          patchDiff: syntaxBrokenPatch1,
          explanation: "Fixed rate limit.",
        },
      })
      .mockResolvedValueOnce({
        output: {
          patchDiff: syntaxBrokenPatch2,
          explanation: "Fixed rate limit second attempt.",
        },
      });

    const result = await generateRemediationPatch({
      filePath: realFilePath,
      findingDescription: "Hardcoded configuration",
      vulnerableCode: originalContent,
      originalContent,
    });

    // Retried once with syntax error feedback
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const retryCallArgs = mockGenerate.mock.calls[1][0];
    expect(retryCallArgs.prompt).toContain(
      "IMPORTANT: The previous patch failed automated verification",
    );
    expect(retryCallArgs.prompt).toContain("Syntax error in typescript");

    // Finding shown without patch and with note
    expect(result.verified).toBe(false);
    expect(result.readyFix).toBe(false);
    expect(result.patchDiff).toBe("");
    expect(result.note).toContain("Patch verification failed");

    // Real file completely unchanged
    const afterStat = fs.statSync(realFilePath);
    expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("successfully recovers on retry when the first attempt breaks syntax and retry generates a valid patch", async () => {
    const realFilePath = path.join(workspaceDir, "user.ts");
    const originalContent = "const id = req.query.id;\n";
    fs.writeFileSync(realFilePath, originalContent, "utf8");
    const beforeStat = fs.statSync(realFilePath);

    // First attempt: breaks syntax
    const brokenPatch =
      "--- a/user.ts\n+++ b/user.ts\n@@ -1 +1 @@\n-const id = req.query.id;\n+const id = req.query.id as ;\n";

    // Second attempt: valid TypeScript
    const validRetryPatch =
      "--- a/user.ts\n+++ b/user.ts\n@@ -1 +1 @@\n-const id = req.query.id;\n+const id = String(req.query.id || '');\n";

    mockGenerate
      .mockResolvedValueOnce({
        output: {
          patchDiff: brokenPatch,
          explanation: "First attempt.",
        },
      })
      .mockResolvedValueOnce({
        output: {
          patchDiff: validRetryPatch,
          explanation: "Corrected type cast.",
        },
      });

    const result = await generateRemediationPatch({
      filePath: realFilePath,
      findingDescription: "Unsafe type access",
      vulnerableCode: originalContent,
      originalContent,
    });

    // Retried and recovered
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.verified).toBe(true);
    expect(result.readyFix).toBe(true);
    expect(result.patchDiff).toBe(validRetryPatch);
    expect(result.explanation).toBe("Corrected type cast.");

    // Real file unchanged
    const afterStat = fs.statSync(realFilePath);
    expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});
