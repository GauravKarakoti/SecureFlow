import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  parseSecureFlowIgnore,
  compileIgnorePatterns,
  shouldIgnorePath,
  normalizeScanPath,
  loadSecureFlowIgnore,
} from "./ignore.js";
import { scanFile, shouldScanFile } from "./scanner.js";

describe("SecureFlow CLI Ignore / Suppress Configuration (.secureflowignore)", () => {
  describe("normalizeScanPath", () => {
    it("converts Windows backslashes to forward slashes and removes leading slashes/dots", () => {
      expect(normalizeScanPath("src\\components\\__mocks__\\api.ts")).toBe(
        "src/components/__mocks__/api.ts",
      );
      expect(normalizeScanPath("./src/test/file.ts")).toBe("src/test/file.ts");
      expect(normalizeScanPath("/root/file.ts")).toBe("root/file.ts");
    });
  });

  describe("parseSecureFlowIgnore", () => {
    it("parses path patterns while ignoring comments and blank lines", () => {
      const content = `
# This is a comment
__mocks__/
*.test.ts

# Another comment
tests/**
legacy/old-auth.ts
`;
      const config = parseSecureFlowIgnore(content);
      expect(config.ignoredPaths).toEqual([
        "__mocks__/",
        "*.test.ts",
        "tests/**",
        "legacy/old-auth.ts",
      ]);
      expect(config.placeholders).toEqual([]);
    });

    it("parses sections: [paths], [files], [placeholders], [mocks]", () => {
      const content = `
[paths]
__mocks__/
fixtures/*.json

[placeholders]
dummy-secret-value
test_token_123

[files]
legacy/module.ts

[mocks]
mock_api_key_456
`;
      const config = parseSecureFlowIgnore(content);
      expect(config.ignoredPaths).toEqual([
        "__mocks__/",
        "fixtures/*.json",
        "legacy/module.ts",
      ]);
      expect(config.placeholders).toEqual([
        "dummy-secret-value",
        "test_token_123",
        "mock_api_key_456",
      ]);
    });
  });

  describe("compileIgnorePatterns and shouldIgnorePath", () => {
    it("matches directory patterns like __mocks__/ in root or nested directories", () => {
      const patterns = compileIgnorePatterns(["__mocks__/"]);

      expect(shouldIgnorePath("__mocks__/auth.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src/__mocks__/auth.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src/components/__mocks__/nested/auth.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src/auth.ts", patterns)).toBe(false);
      expect(shouldIgnorePath("src/not__mocks__/auth.ts", patterns)).toBe(false);
    });

    it("matches file extension globs like *.test.ts and *.spec.js", () => {
      const patterns = compileIgnorePatterns(["*.test.ts", "*.spec.js"]);

      expect(shouldIgnorePath("auth.test.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src/auth.test.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src/nested/user.spec.js", patterns)).toBe(true);
      expect(shouldIgnorePath("src/auth.ts", patterns)).toBe(false);
      expect(shouldIgnorePath("src/test.ts", patterns)).toBe(true);
    });

    it("matches multi-segment wildcard glob patterns tests/** and fixtures/*", () => {
      const patterns = compileIgnorePatterns(["tests/**", "fixtures/*"]);

      expect(shouldIgnorePath("tests/unit/login.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("tests/e2e/nested/deep/flow.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("fixtures/mock-db.json", patterns)).toBe(true);
      expect(shouldIgnorePath("src/tests/login.ts", patterns)).toBe(false);
    });

    it("matches root-anchored paths starting with /", () => {
      const patterns = compileIgnorePatterns(["/legacy/old-code.ts"]);

      expect(shouldIgnorePath("legacy/old-code.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("/legacy/old-code.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src/legacy/old-code.ts", patterns)).toBe(false);
    });

    it("handles Windows backslashes in tested file paths", () => {
      const patterns = compileIgnorePatterns(["__mocks__/", "tests/**"]);

      expect(shouldIgnorePath("src\\__mocks__\\login.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("tests\\unit\\sub\\test.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("src\\valid\\code.ts", patterns)).toBe(false);
    });

    it("returns false when custom ignores list is empty or undefined", () => {
      expect(shouldIgnorePath("src/file.ts", [])).toBe(false);
      expect(shouldIgnorePath("src/file.ts", undefined as any)).toBe(false);
    });
  });

  describe("Integration with scanFile and shouldScanFile", () => {
    const ignorePatterns = compileIgnorePatterns([
      "__mocks__/",
      "*.test.ts",
      "legacy/**",
    ]);

    it("shouldScanFile returns false for ignored paths", () => {
      expect(shouldScanFile("src/__mocks__/api.ts", undefined, ignorePatterns)).toBe(false);
      expect(shouldScanFile("src/auth.test.ts", undefined, ignorePatterns)).toBe(false);
      expect(shouldScanFile("legacy/old.ts", undefined, ignorePatterns)).toBe(false);
      expect(shouldScanFile("src/auth.ts", undefined, ignorePatterns)).toBe(true);
    });

    it("scanFile skips files matching ignore rules with informative reason", () => {
      const ignoredResult = scanFile(
        "src/__mocks__/api.ts",
        'console.log("Secret:", process.env.SECRET_KEY);',
        ignorePatterns,
      );

      expect(ignoredResult.path).toBe("src/__mocks__/api.ts");
      expect(ignoredResult.violations).toHaveLength(0);
      expect(ignoredResult.skipped).toBe("matched .secureflowignore");
    });

    it("scanFile still catches violations in non-ignored files", () => {
      const nonIgnoredResult = scanFile(
        "src/auth.ts",
        'console.log("Secret:", process.env.SECRET_KEY);',
        ignorePatterns,
      );

      expect(nonIgnoredResult.path).toBe("src/auth.ts");
      expect(nonIgnoredResult.violations).toHaveLength(1);
      expect(nonIgnoredResult.skipped).toBeUndefined();
    });
  });

  describe("loadSecureFlowIgnore filesystem loader", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-ignore-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("loads and compiles .secureflowignore from repository directory", () => {
      const ignoreFilePath = path.join(tempDir, ".secureflowignore");
      fs.writeFileSync(
        ignoreFilePath,
        "# Test config\n__mocks__/\n*.mock.ts\n[placeholders]\nfake-api-key\n",
        "utf-8",
      );

      const result = loadSecureFlowIgnore(undefined, tempDir);
      expect(result).not.toBeNull();
      expect(result?.config.ignoredPaths).toEqual(["__mocks__/", "*.mock.ts"]);
      expect(result?.config.placeholders).toEqual(["fake-api-key"]);
      expect(result?.compiledPatterns.length).toBe(2);

      expect(shouldIgnorePath("src/__mocks__/user.ts", result?.compiledPatterns)).toBe(true);
      expect(shouldIgnorePath("src/services/api.mock.ts", result?.compiledPatterns)).toBe(true);
      expect(shouldIgnorePath("src/services/api.ts", result?.compiledPatterns)).toBe(false);
    });

    it("loads custom ignore file when custom path is provided", () => {
      const customPath = path.join(tempDir, "custom.ignore");
      fs.writeFileSync(customPath, "legacy/**\n", "utf-8");

      const result = loadSecureFlowIgnore("custom.ignore", tempDir);
      expect(result).not.toBeNull();
      expect(result?.config.ignoredPaths).toEqual(["legacy/**"]);
      expect(shouldIgnorePath("legacy/database.ts", result?.compiledPatterns)).toBe(true);
    });

    it("returns null when ignore file does not exist", () => {
      const result = loadSecureFlowIgnore(undefined, tempDir);
      expect(result).toBeNull();
    });
  });
});
