import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyPatchToContent,
  parseSyntax,
  verifyPatchInTempCopy,
  detectLanguageFromPath,
} from "./patch-verifier";

describe("PatchVerifier", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-workspace-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup
    }
  });

  describe("applyPatchToContent", () => {
    it("applies a clean unified diff patch", () => {
      const source = "const a = 1;\nconst b = 2;\nconsole.log(a, b);\n";
      const patch =
        "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -2,2 +2,2 @@\n const b = 2;\n-console.log(a, b);\n+logger.info(a, b);\n";

      const res = applyPatchToContent(source, patch, "src/index.ts");
      expect(res.success).toBe(true);
      expect(res.patchedContent).toBe("const a = 1;\nconst b = 2;\nlogger.info(a, b);\n");
    });

    it("fails when context does not match", () => {
      const source = "const a = 1;\nconst b = 2;\n";
      const patch =
        "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,2 +1,2 @@\n const a = 999;\n-const b = 2;\n+const b = 3;\n";

      const res = applyPatchToContent(source, patch, "src/index.ts");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Patch context mismatch");
    });

    it("fails when removal line does not match", () => {
      const source = "const secret = 'password123';\n";
      const patch =
        "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const secret = 'different';\n+const secret = process.env.SECRET;\n";

      const res = applyPatchToContent(source, patch, "src/index.ts");
      expect(res.success).toBe(false);
      expect(res.error).toContain("Patch removal mismatch");
    });

    it("fails when hunk offset is out of file bounds", () => {
      const source = "const a = 1;\n";
      const patch =
        "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -50,1 +50,1 @@\n-const b = 2;\n+const b = 3;\n";

      const res = applyPatchToContent(source, patch, "src/index.ts");
      expect(res.success).toBe(false);
      expect(res.error).toContain("outside current file boundaries");
    });
  });

  describe("parseSyntax", () => {
    it("detects languages accurately from paths", () => {
      expect(detectLanguageFromPath("src/app.ts")).toBe("typescript");
      expect(detectLanguageFromPath("src/App.tsx")).toBe("typescript");
      expect(detectLanguageFromPath("lib/math.js")).toBe("javascript");
      expect(detectLanguageFromPath("config.json")).toBe("json");
      expect(detectLanguageFromPath("script.py")).toBe("python");
    });

    it("validates correct TypeScript/JavaScript syntax", () => {
      const validCode =
        "import fs from 'fs';\nexport const x: number = 42;\nfunction run() { return x; }";
      const res = parseSyntax("src/service.ts", validCode);
      expect(res.valid).toBe(true);
      expect(res.language).toBe("typescript");
    });

    it("detects syntax errors in TypeScript/JavaScript", () => {
      const brokenCode = "const x = ;\nfunction broken( { return 1; ";
      const res = parseSyntax("src/broken.ts", brokenCode);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Syntax error in typescript");
    });

    it("validates correct JSON syntax", () => {
      const validJson = JSON.stringify({ name: "secureflow", active: true, count: 10 }, null, 2);
      const res = parseSyntax("package.json", validJson);
      expect(res.valid).toBe(true);
    });

    it("detects syntax errors in JSON", () => {
      const brokenJson = "{ name: 'unquoted', trailing: 123, }";
      const res = parseSyntax("settings.json", brokenJson);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("JSON syntax error");
    });

    it("validates correct Python syntax", () => {
      const validPy =
        "def calculate_tax(amount):\n    if amount > 100:\n        return amount * 0.2\n    return 0\n";
      const res = parseSyntax("calc.py", validPy);
      expect(res.valid).toBe(true);
      expect(res.language).toBe("python");
    });

    it("detects syntax errors in Python (missing colon, unmatched parentheses)", () => {
      const brokenPy = "def broken(x\n    return x + 1";
      const res = parseSyntax("broken.py", brokenPy);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("Python syntax error");
    });

    it("detects JS keywords in Python", () => {
      const jsInPy = "const x = 10\nlet y = 20\n";
      const res = parseSyntax("script.py", jsInPy);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("JavaScript keyword detected");
    });
  });

  describe("verifyPatchInTempCopy (Workspace Safety & Patch Validation)", () => {
    it("verifies a valid patch and keeps real files unchanged", async () => {
      const realFilePath = path.join(workspaceDir, "service.ts");
      const originalCode =
        "export function logToken(token: string) {\n  console.log('Token:', token);\n}\n";
      fs.writeFileSync(realFilePath, originalCode, "utf8");

      const beforeStat = fs.statSync(realFilePath);

      const validPatch =
        "--- a/service.ts\n+++ b/service.ts\n@@ -1,3 +1,3 @@\n export function logToken(token: string) {\n-  console.log('Token:', token);\n+  console.log('Token: [REDACTED]');\n }\n";

      const result = await verifyPatchInTempCopy({
        filePath: "service.ts",
        originalContent: originalCode,
        patchDiff: validPatch,
        realWorkspacePath: realFilePath,
      });

      expect(result.verified).toBe(true);
      expect(result.readyFix).toBe(true);
      expect(result.appliedCleanly).toBe(true);
      expect(result.syntaxValid).toBe(true);
      expect(result.patchedContent).toContain("Token: [REDACTED]");

      // CRITICAL ACCEPTANCE CRITERIA: Real file remains 100% unchanged
      const afterStat = fs.statSync(realFilePath);
      expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalCode);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
      expect(afterStat.size).toBe(beforeStat.size);
    });

    it("fails a patch that does not apply cleanly and keeps real files unchanged", async () => {
      const realFilePath = path.join(workspaceDir, "handler.ts");
      const originalCode = "function handle() {\n  return 42;\n}\n";
      fs.writeFileSync(realFilePath, originalCode, "utf8");

      const beforeStat = fs.statSync(realFilePath);

      const failingPatch =
        "--- a/handler.ts\n+++ b/handler.ts\n@@ -1,3 +1,3 @@\n function completelyDifferent() {\n-  return 0;\n+  return 1;\n }\n";

      const result = await verifyPatchInTempCopy({
        filePath: "handler.ts",
        originalContent: originalCode,
        patchDiff: failingPatch,
        realWorkspacePath: realFilePath,
      });

      expect(result.verified).toBe(false);
      expect(result.readyFix).toBe(false);
      expect(result.appliedCleanly).toBe(false);
      expect(result.error).toContain("Patch context mismatch");
      expect(result.note).toContain("AI-suggested patch could not be applied cleanly");

      // Real files unchanged
      const afterStat = fs.statSync(realFilePath);
      expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalCode);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });

    it("fails a syntax-breaking patch and keeps real files unchanged", async () => {
      const realFilePath = path.join(workspaceDir, "calc.ts");
      const originalCode = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
      fs.writeFileSync(realFilePath, originalCode, "utf8");

      const beforeStat = fs.statSync(realFilePath);

      // Applies cleanly, but breaks syntax with invalid code
      const syntaxBreakingPatch =
        "--- a/calc.ts\n+++ b/calc.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number) {\n-  return a + b;\n+  return a + ;\n }\n";

      const result = await verifyPatchInTempCopy({
        filePath: "calc.ts",
        originalContent: originalCode,
        patchDiff: syntaxBreakingPatch,
        realWorkspacePath: realFilePath,
      });

      expect(result.verified).toBe(false);
      expect(result.readyFix).toBe(false);
      expect(result.appliedCleanly).toBe(true);
      expect(result.syntaxValid).toBe(false);
      expect(result.error).toContain("Syntax error in typescript");
      expect(result.note).toContain("AI-suggested patch breaks syntax");

      // Real files unchanged
      const afterStat = fs.statSync(realFilePath);
      expect(fs.readFileSync(realFilePath, "utf8")).toBe(originalCode);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });
  });
});
