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
  DEFAULT_IGNORE_PATTERNS,
  getEffectiveIgnorePatterns,
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
      expect(config.ignoredPaths).toEqual(["__mocks__/", "fixtures/*.json", "legacy/module.ts"]);
      expect(config.placeholders).toEqual([
        "dummy-secret-value",
        "test_token_123",
        "mock_api_key_456",
      ]);
    });

    it("parses entries with reason, expiry and handles expiration", () => {
      const fixedNow = new Date("2026-11-18T12:00:00Z");
      const content = `
active/** [expires=2026-12-31]: Active rule
expired/** [expires=2026-11-01]: Expired rule
colon/**: Rule with colon reason
malformed/** [expires=2026-02-31]: Malformed date
no-reason/**
`;
      const config = parseSecureFlowIgnore(content, { now: fixedNow });

      expect(config.ignoredPaths).toEqual([
        "active/**",
        "colon/**",
        "malformed/**",
        "no-reason/**",
      ]);
      expect(config.expiredRules).toEqual([
        {
          pattern: "expired/**",
          expires: "2026-11-01",
          reason: "Expired rule",
        },
      ]);
      expect(config.warnings?.some((w) => w.includes('Invalid expiration date "2026-02-31"'))).toBe(
        true,
      );
      expect(config.warnings?.some((w) => w.includes("has no reason specified"))).toBe(true);
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

      // `*.test.ts` is "anything, then `.test.ts`". A file actually named
      // test.ts has no `.test` segment before its extension, so it is not a
      // test file by this pattern and must not be ignored.
      expect(shouldIgnorePath("src/test.ts", patterns)).toBe(false);
      // The empty match is still a match, as gitignore treats it.
      expect(shouldIgnorePath("src/.test.ts", patterns)).toBe(true);
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
    const ignorePatterns = compileIgnorePatterns(["__mocks__/", "*.test.ts", "legacy/**"]);

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

    it("falls back to default ignore patterns when ignore file is missing", () => {
      const result = loadSecureFlowIgnore(undefined, tempDir);
      expect(result).toBeNull();

      const effectiveIgnores = getEffectiveIgnorePatterns(result?.config.ignoredPaths ?? []);
      expect(shouldIgnorePath("node_modules/axios/index.js", effectiveIgnores)).toBe(true);
      expect(shouldIgnorePath("dist/bundle.js", effectiveIgnores)).toBe(true);
      expect(shouldIgnorePath("package-lock.json", effectiveIgnores)).toBe(true);
      expect(shouldIgnorePath("src/index.ts", effectiveIgnores)).toBe(false);
    });
  });

  describe("Negation patterns (!)", () => {
    it("allows un-ignoring specific files with !pattern", () => {
      const patterns = compileIgnorePatterns(["fixtures/**", "!fixtures/keep.ts"]);

      expect(shouldIgnorePath("fixtures/other.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("fixtures/nested/other.ts", patterns)).toBe(true);
      expect(shouldIgnorePath("fixtures/keep.ts", patterns)).toBe(false);
      expect(shouldIgnorePath("src/app.ts", patterns)).toBe(false);
    });

    it("evaluates negation in sequential rule order where later rules override earlier ones", () => {
      const reIgnored = compileIgnorePatterns(["!important.ts", "*.ts"]);
      expect(shouldIgnorePath("important.ts", reIgnored)).toBe(true);

      const unIgnored = compileIgnorePatterns(["*.ts", "!important.ts"]);
      expect(shouldIgnorePath("important.ts", unIgnored)).toBe(false);
      expect(shouldIgnorePath("other.ts", unIgnored)).toBe(true);
    });

    it("allows negating default ignore patterns such as vendored packages", () => {
      const patterns = getEffectiveIgnorePatterns(["!node_modules/my-vendored-lib/**"]);

      expect(shouldIgnorePath("node_modules/other-lib/index.js", patterns)).toBe(true);
      expect(shouldIgnorePath("node_modules/my-vendored-lib/index.js", patterns)).toBe(false);
    });

    it("handles negation in nested directories", () => {
      const patterns = compileIgnorePatterns([
        "packages/api/fixtures/**",
        "!packages/api/fixtures/keep.json",
      ]);

      expect(shouldIgnorePath("packages/api/fixtures/data.json", patterns)).toBe(true);
      expect(shouldIgnorePath("packages/api/fixtures/nested/data.json", patterns)).toBe(true);
      expect(shouldIgnorePath("packages/api/fixtures/keep.json", patterns)).toBe(false);
    });
  });

  describe("Default ignore patterns and nested directories", () => {
    const defaultIgnores = compileIgnorePatterns([...DEFAULT_IGNORE_PATTERNS]);

    it.each([
      "node_modules/lodash/index.js",
      "packages/web/node_modules/react/index.js",
      "apps/backend/deep/node_modules/pg/index.js",
      "dist/bundle.js",
      "packages/cli/dist/index.js",
      "build/app.js",
      "client/build/static/js/main.js",
      ".next/server/pages.js",
      "apps/web/.next/cache/data.json",
      "coverage/lcov.info",
      "sub/coverage/index.html",
      "target/debug/app",
      "package-lock.json",
      "packages/ui/package-lock.json",
      "yarn.lock",
      "backend/yarn.lock",
      "pnpm-lock.yaml",
      "nested/dir/pnpm-lock.yaml",
      "Cargo.lock",
      "crates/core/Cargo.lock",
      "Gemfile.lock",
      "poetry.lock",
      "composer.lock",
    ])("skips default path %s", (path) => {
      expect(shouldIgnorePath(path, defaultIgnores)).toBe(true);
    });

    it.each([
      "src/index.ts",
      "src/components/Button.tsx",
      "packages/core/src/service.ts",
      "lib/auth.ts",
      "distribution.ts",
      "src/rebuild.ts",
    ])("does not skip normal source file %s", (path) => {
      expect(shouldIgnorePath(path, defaultIgnores)).toBe(false);
    });

    it("matches directory pattern without trailing slash in root and nested directories", () => {
      const patterns = compileIgnorePatterns(["fixtures", "vendor"]);

      expect(shouldIgnorePath("fixtures/data.json", patterns)).toBe(true);
      expect(shouldIgnorePath("packages/app/fixtures/data.json", patterns)).toBe(true);
      expect(shouldIgnorePath("vendor/lib.js", patterns)).toBe(true);
      expect(shouldIgnorePath("sub/vendor/lib.js", patterns)).toBe(true);
      expect(shouldIgnorePath("fixtures.json", patterns)).toBe(false);
      expect(shouldIgnorePath("my_fixtures/data.json", patterns)).toBe(false);
    });

    it("scanFile skips node_modules and build directories by default even with no customIgnores", () => {
      const nodeModulesResult = scanFile(
        "node_modules/pkg/index.js",
        'console.log("Secret:", process.env.SECRET_KEY);',
      );
      expect(nodeModulesResult.skipped).toBe("matched .secureflowignore");
      expect(nodeModulesResult.violations).toHaveLength(0);

      const distResult = scanFile(
        "packages/app/dist/bundle.js",
        'console.log("Secret:", process.env.SECRET_KEY);',
      );
      expect(distResult.skipped).toBe("matched .secureflowignore");
      expect(distResult.violations).toHaveLength(0);

      const normalResult = scanFile(
        "src/app.ts",
        'console.log("Secret:", process.env.SECRET_KEY);',
      );
      expect(normalResult.skipped).toBeUndefined();
      expect(normalResult.violations).toHaveLength(1);
    });
  });

  describe("glob translation", () => {
    const matches = (glob: string, path: string) =>
      compileIgnorePatterns([glob]).some((re) => re.test(path));

    it.each([
      ["config.*", "config.json"],
      ["secrets.*", "src/secrets.yaml"],
      ["*.test.*", "src/a.test.ts"],
      ["fixtures/*.*", "fixtures/a.json"],
      ["src/*.ts", "src/a.ts"],
      ["docs/**", "docs/a/b.md"],
      ["**/generated/*.ts", "a/b/generated/x.ts"],
      ["a/**/b.ts", "a/b.ts"],
      ["*.log", "logs/app.log"],
      ["file?.txt", "file1.txt"],
    ])("%s matches %s", (glob, path) => {
      expect(matches(glob, path)).toBe(true);
    });

    it.each([
      // A glob dot is a literal dot, not "zero or more dots".
      ["config.*", "config"],
      // A single * stays within one path segment.
      ["src/*.ts", "src/a/b.ts"],
      ["src/*.ts", "src.ts"],
      ["fixtures/*.*", "fixtures/a/b.json"],
      ["file?.txt", "file10.txt"],
      ["*.log", "app.log.gz"],
    ])("%s does not match %s", (glob, path) => {
      expect(matches(glob, path)).toBe(false);
    });
  });
});

describe("globToRegexSource ** segment boundaries", () => {
  it("treats ** inside a name as a single-star segment", () => {
    const patterns = compileIgnorePatterns(["a**b"]);
    expect(patterns.some((re) => re.test("axxb"))).toBe(true);
    expect(patterns.some((re) => re.test("a/b"))).toBe(false);
    expect(patterns.some((re) => re.test("src/a/b.ts"))).toBe(false);
  });

  it("still matches recursive ** as a full segment", () => {
    const patterns = compileIgnorePatterns(["tests/**"]);
    expect(patterns.some((re) => re.test("tests/a/b.ts"))).toBe(true);
    expect(patterns.some((re) => re.test("src/a.ts"))).toBe(false);
  });
});
