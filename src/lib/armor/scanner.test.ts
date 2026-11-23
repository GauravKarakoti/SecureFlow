import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockCreate } from "../../../__mocks__/groq-sdk";
import {
  maskSecrets,
  ArmorIQScanner,
  parseSecureFlowIgnore,
  extractAddedLines,
  shouldIgnore,
  sanitizeRecursively,
  filterFalsePositives,
  compileIgnorePatterns,
  resolveScanModel,
} from "./scanner";
import type { ScanFinding } from "./scanner";

// ─── maskSecrets ──────────────────────────────────────────────────────────────

describe("maskSecrets", () => {
  it("returns empty string for empty input", () => {
    expect(maskSecrets("")).toBe("");
  });

  it("redacts Anthropic API keys", () => {
    const input = "api key is sk-ant-api03-abcdef1234567890abcdef1234567890 more text";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
    expect(maskSecrets(input)).not.toContain("sk-ant-api03-");
  });

  it("redacts GitHub PATs (ghp_ format)", () => {
    const input = "token=ghp_abcdefghijklmnopqrstuvwxyzabcdefghijklm";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts GitHub PATs (github_pat_ format)", () => {
    const input =
      "token=github_pat_11AAABBB111_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefg";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts JSON Web Tokens", () => {
    const input =
      "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3j_VN3M5qVZgX5vLQ7zGQ6R8y3Kx9w0c";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts OpenAI sk- API keys", () => {
    const input = "key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890abcdef";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts Stripe API keys", () => {
    // Stripe key pattern: sk_live_ prefix — value split to avoid secret scanning
    const prefix = "sk_li" + "ve_";
    const input = `stripe=${prefix}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts Slack tokens", () => {
    // Slack token pattern: xoxb- prefix — value split to avoid secret scanning
    const prefix = "xox" + "b-";
    const input = `slack=${prefix}0000000000-XXXXXXXXXXXXXXXXXXXXXXXX`;
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts AWS access keys", () => {
    const input = "aws=AKIAIOSFODNN7EXAMPLE";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
  });

  it("redacts database passwords in connection URIs", () => {
    const input = "mongodb://user:supersecret@localhost:27017/mydb";
    expect(maskSecrets(input)).toContain("[REDACTED_BY_THE_PROFESSOR]");
    expect(maskSecrets(input)).toContain("mongodb://user:");
    expect(maskSecrets(input)).not.toContain("supersecret");
  });

  it("returns non-secret text unchanged", () => {
    const text = "const x = 42; // normal comment";
    expect(maskSecrets(text)).toBe(text);
  });
});

describe("extractAddedLines", () => {
  it("returns empty string for empty input", () => {
    expect(extractAddedLines("")).toBe("");
  });

  it("extracts lines starting with + and tags them with line numbers", () => {
    const patch = [
      "--- a/src/db.ts",
      "+++ b/src/db.ts",
      "@@ -1,3 +1,4 @@",
      " const x = 1;",
      " const y = 2;",
      "+const z = 3;",
      '+const secret = "sk-live-abc";',
      " const w = 4;",
    ].join("\n");

    const result = extractAddedLines(patch);
    expect(result).toContain("3: const z = 3;");
    expect(result).toContain('4: const secret = "sk-live-abc";');
    expect(result).toContain("1: const x = 1;");
  });

  it("filters out ---, +++, and @@ header lines", () => {
    const patch = ["--- a/file.ts", "+++ b/file.ts", "@@ -0,0 +1 @@", "+new line"].join("\n");

    const result = extractAddedLines(patch);
    expect(result).not.toContain("---");
    expect(result).not.toContain("+++");
    expect(result).not.toContain("@@");
    expect(result).toContain("1: new line");
  });

  it("preserves context lines with line numbers", () => {
    const patch = [" unchanged", "+added"].join("\n");

    const result = extractAddedLines(patch);
    expect(result).toContain("0: unchanged");
    expect(result).toContain("1: added");
  });
});

// ─── shouldIgnore ─────────────────────────────────────────────────────────────

describe("shouldIgnore", () => {
  it("ignores files in dist/ directory", () => {
    expect(shouldIgnore("dist/output.js")).toBe(true);
  });

  it("ignores files in node_modules/", () => {
    expect(shouldIgnore("node_modules/package/index.js")).toBe(true);
  });

  it("ignores files with .md extension", () => {
    expect(shouldIgnore("README.md")).toBe(true);
  });

  it("ignores .lock files", () => {
    expect(shouldIgnore("package-lock.json")).toBe(true);
  });

  it("does NOT ignore .env.example files", () => {
    expect(shouldIgnore(".env.example")).toBe(false);
  });

  it("ignores package.json", () => {
    expect(shouldIgnore("package.json")).toBe(true);
  });

  it("ignores .gitignore", () => {
    expect(shouldIgnore(".gitignore")).toBe(true);
  });

  it("uses custom ignore patterns", () => {
    const customPatterns = compileIgnorePatterns(["custom-dir/"]);
    expect(shouldIgnore("custom-dir/some-file.ts", customPatterns)).toBe(true);
  });

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

  it("does not ignore regular source files", () => {
    expect(shouldIgnore("src/app.ts")).toBe(false);
    expect(shouldIgnore("src/components/Button.tsx")).toBe(false);
  });
});

// ─── sanitizeRecursively ──────────────────────────────────────────────────────

describe("sanitizeRecursively", () => {
  it("decodes HTML entities", () => {
    expect(sanitizeRecursively("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  it("removes zero-width characters", () => {
    const input = "hello\u200Bworld\u200Ctest";
    expect(sanitizeRecursively(input)).toBe("helloworldtest");
  });

  it("handles nested encoding recursively", () => {
    const input = "&lt;script>";
    const result = sanitizeRecursively(input);
    expect(result).not.toContain("&lt;");
  });

  it("truncates at MAX_SANITIZED_LENGTH (100k)", () => {
    const long = "x".repeat(150000);
    expect(sanitizeRecursively(long).length).toBe(100000);
  });

  it("returns unchanged input when no decoding needed", () => {
    const text = 'const x = "hello world";';
    expect(sanitizeRecursively(text)).toBe(text);
  });

  it("decodes decimal numeric HTML entities", () => {
    expect(sanitizeRecursively("&#60;")).toBe("<");
  });

  it("decodes hexadecimal numeric HTML entities (lowercase x)", () => {
    expect(sanitizeRecursively("&#x3C;")).toBe("<");
  });

  it("decodes hexadecimal numeric HTML entities (uppercase X)", () => {
    expect(sanitizeRecursively("&#X3C;")).toBe("<");
  });

  it("decodes astral Unicode code points from hexadecimal entities", () => {
    expect(sanitizeRecursively("&#x1F600;")).toBe("😀");
  });

  it("decodes astral Unicode code points from decimal entities", () => {
    expect(sanitizeRecursively("&#128512;")).toBe("😀");
  });

  it("recursively decodes nested numeric HTML entities", () => {
    const input = "&#60;script&#62;";
    const result = sanitizeRecursively(input);
    expect(result).toBe("<script>");
  });

  it("leaves malformed hexadecimal entities unchanged", () => {
    expect(sanitizeRecursively("&#xZZ;")).toBe("&#xZZ;");
  });

  it("leaves code points above Unicode maximum unchanged", () => {
    expect(sanitizeRecursively("&#x110000;")).toBe("&#x110000;");
  });

  it("leaves lone UTF-16 surrogate unchanged", () => {
    expect(sanitizeRecursively("&#55296;")).toBe("&#55296;");
  });

  it("normalizes full-width characters to ASCII via NFKC", () => {
    expect(sanitizeRecursively("ＡＢＣ１２３")).toBe("ABC123");
  });
});

// ─── filterFalsePositives ─────────────────────────────────────────────────────

describe("filterFalsePositives", () => {
  const makeFinding = (overrides: Partial<ScanFinding> = {}): ScanFinding => ({
    type: "Secret",
    severity: "HIGH",
    description: "API key found",
    fileLocation: "src/file.ts",
    codeSnippet: 'const key = "sk-live-abc123"',
    ...overrides,
  });

  it("removes findings in .env.example files with placeholder values", () => {
    const findings = [
      makeFinding({ fileLocation: ".env.example", codeSnippet: "API_KEY=your_actual_key_here" }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(0);
  });

  it("removes findings in .env.example files with empty values", () => {
    const findings = [makeFinding({ fileLocation: ".env.example", codeSnippet: 'API_KEY=""' })];
    expect(filterFalsePositives(findings)).toHaveLength(0);
  });

  it("retains findings in .env.example with real-looking high-entropy credentials", () => {
    const findings = [
      makeFinding({
        fileLocation: ".env.example",
        codeSnippet: "API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz1234567890",
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(1);
  });

  it("removes findings in seed.ts with placeholder values", () => {
    const findings = [
      makeFinding({
        fileLocation: "prisma/seed.ts",
        codeSnippet: 'description: "your_description_here"',
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(0);
  });

  it("removes false logic flaws in schema.prisma", () => {
    const findings = [
      makeFinding({
        type: "Vulnerability",
        fileLocation: "prisma/schema.prisma",
        codeSnippet: "id Int @id",
        description: "Int type used",
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(0);
  });

  it("retains real findings in non-special files", () => {
    const findings = [
      makeFinding({
        fileLocation: "src/api/route.ts",
        codeSnippet: "console.log(process.env.API_KEY)",
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(1);
  });

  it("retains console.log(process.env...) leaks even inside seed files", () => {
    // The core rule says these MUST be flagged; the old bare console.log filter
    // silently discarded this genuine secret leak.
    const findings = [
      makeFinding({
        fileLocation: "prisma/seed.ts",
        codeSnippet: "console.log(process.env.DATABASE_PASSWORD)",
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(1);
  });

  it("still drops plain console.log noise in seed files", () => {
    const findings = [
      makeFinding({
        fileLocation: "prisma/seed.ts",
        codeSnippet: 'console.log("seeding users...")',
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(0);
  });

  it('retains schema.prisma findings whose snippet merely contains "int"/"string" as a substring', () => {
    // "userFingerprint" contains the substring "int"; the old includes('int')
    // check dropped this real finding. No standalone Int/String type token here.
    const findings = [
      makeFinding({
        fileLocation: "prisma/schema.prisma",
        codeSnippet: 'userFingerprint @default("leaked-secret-abc123")',
        description: "Hardcoded default value",
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(1);
  });

  it("still drops real Prisma type-only findings on word boundaries", () => {
    const findings = [
      makeFinding({
        type: "Vulnerability",
        fileLocation: "prisma/schema.prisma",
        codeSnippet: "id Int @id",
        description: "Int type used",
      }),
    ];
    expect(filterFalsePositives(findings)).toHaveLength(0);
  });
});

// ─── Configurable ignores (.secureflowignore) ────────────────────────────────

describe("Configurable ignores and false positive filtering (.secureflowignore)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("correctly parses .secureflowignore files with comments and sections", () => {
    const configContent = `
# This is a comment
dist/
build/
*.test.ts

[placeholders]
# Mock value section
my_custom_placeholder
test_dummy_value
[mocks]
another_placeholder
    `;
    const parsed = parseSecureFlowIgnore(configContent);
    expect(parsed.ignoredPaths).toEqual(["dist/", "build/", "*.test.ts"]);
    expect(parsed.placeholders).toEqual([
      "my_custom_placeholder",
      "test_dummy_value",
      "another_placeholder",
    ]);
  });

  it("filters out custom placeholders when provided", async () => {
    const scannerInstance = new ArmorIQScanner();
    const files = [{ filename: "seed.ts", patch: '+const secret = "MY_SPECIAL_MOCK_VALUE";' }];

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  type: "Hardcoded Secret",
                  severity: "HIGH",
                  description: "Hardcoded secret value found",
                  fileLocation: "seed.ts",
                  codeSnippet: 'const secret = "MY_SPECIAL_MOCK_VALUE";',
                },
              ],
            }),
          },
        },
      ],
    });

    const findings1 = await scannerInstance.scanPullRequest(files, []);
    expect(findings1).toHaveLength(1);
    // The finding survives the filter (no placeholder was configured), and the
    // assigned value is redacted on the way out — a literal assigned to a
    // variable named `secret` is exactly what must not reach a PR comment
    // (#591). The variable name is kept: it is not the secret, and a reviewer
    // needs it. Redaction happens after filterFalsePositives, so the placeholder
    // matching below still sees the original text.
    expect(findings1[0].codeSnippet).toBe('const secret = "[REDACTED_BY_THE_PROFESSOR]";');

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  type: "Hardcoded Secret",
                  severity: "HIGH",
                  description: "Hardcoded secret value found",
                  fileLocation: "seed.ts",
                  codeSnippet: 'const secret = "MY_SPECIAL_MOCK_VALUE";',
                },
              ],
            }),
          },
        },
      ],
    });

    const findings2 = await scannerInstance.scanPullRequest(
      files,
      [],
      [],
      ["MY_SPECIAL_MOCK_VALUE"],
    );
    expect(findings2).toHaveLength(0);
  });

  it("excludes files matching custom ignore patterns from scanPullRequest", async () => {
    const scannerInstance = new ArmorIQScanner();
    const files = [
      { filename: "src/app.test.ts", patch: '+const token = "ghp_12345";' },
      { filename: "src/index.ts", patch: "+const x = 5;" },
    ];

    await scannerInstance.scanPullRequest(files, [], ["*.test.ts"]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const promptContent = mockCreate.mock.calls[0][0].messages[1].content;
    expect(promptContent).toContain("src/index.ts");
    expect(promptContent).not.toContain("src/app.test.ts");
  });

  it("passes an AbortSignal to the LLM call so the abort timer can cancel it (#582)", async () => {
    const scannerInstance = new ArmorIQScanner();
    const files = [{ filename: "src/index.ts", patch: "+const x = 5;" }];

    await scannerInstance.scanPullRequest(files, []);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const requestOptions = mockCreate.mock.calls[0][1];
    // Without the signal wired in, controller.abort() was a no-op and the
    // AbortError handler was unreachable dead code.
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  describe("default ignore patterns in scanPullRequest (#1983)", () => {
    it("excludes default-ignored files from LLM scanning and counts them in lastDefaultSkippedCount", async () => {
      const scannerInstance = new ArmorIQScanner();
      const files = [
        { filename: "package-lock.json", patch: '+ "version": "1.0.0"' },
        { filename: "vendor/lib.js", patch: "+ const x = 1;" },
        { filename: "src/index.ts", patch: "+ const y = 2;" },
      ];

      await scannerInstance.scanPullRequest(files, []);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const promptContent = mockCreate.mock.calls[0][0].messages[1].content;
      expect(promptContent).toContain("src/index.ts");
      expect(promptContent).not.toContain("package-lock.json");
      expect(promptContent).not.toContain("vendor/lib.js");
      expect(scannerInstance.lastDefaultSkippedCount).toBe(2);
      expect(scannerInstance.lastDefaultSkippedFiles).toContain("package-lock.json");
      expect(scannerInstance.lastDefaultSkippedFiles).toContain("vendor/lib.js");
    });

    it("runs deterministic secret pre-scan on files skipped from LLM scanning", async () => {
      const scannerInstance = new ArmorIQScanner();
      const files = [
        {
          filename: "package-lock.json",
          patch: '+ "token": "ghp_111111111111111111111111111111111111"',
        },
        { filename: "src/index.ts", patch: "+ const y = 2;" },
      ];

      const findings = await scannerInstance.scanPullRequest(files, []);

      // package-lock.json was skipped from LLM prompt
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const promptContent = mockCreate.mock.calls[0][0].messages[1].content;
      expect(promptContent).not.toContain("package-lock.json");

      // But deterministic pre-scan found the secret in package-lock.json!
      const secretFinding = findings.find((f) => f.fileLocation === "package-lock.json");
      expect(secretFinding).toBeDefined();
      expect(secretFinding?.type).toBe("Secret");
      expect(scannerInstance.lastDefaultSkippedCount).toBe(1);
    });

    it("never skips default-ignored files if they are the only files changed and contain secret-like strings", async () => {
      const scannerInstance = new ArmorIQScanner();
      // Only one file changed in the PR: package-lock.json containing a real secret
      const files = [
        {
          filename: "package-lock.json",
          patch: '+ "apiKey": "AKIA99XM2PLKD93HTRWN"',
        },
      ];

      const findings = await scannerInstance.scanPullRequest(files, []);

      expect(scannerInstance.lastDefaultSkippedCount).toBe(0);
      expect(scannerInstance.lastAnalyzedFiles).toContain("package-lock.json");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].fileLocation).toBe("package-lock.json");
    });

    it("allows repositories to disable defaults with includeDefaults: false", async () => {
      const scannerInstance = new ArmorIQScanner();
      const files = [{ filename: "package-lock.json", patch: '+ "test": true' }];

      await scannerInstance.scanPullRequest(files, [], [], [], "test-repo", {
        includeDefaults: false,
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const promptContent = mockCreate.mock.calls[0][0].messages[1].content;
      expect(promptContent).toContain("package-lock.json");
      expect(scannerInstance.lastDefaultSkippedCount).toBe(0);
    });

    it("allows repositories to force-include files with forceInclude", async () => {
      const scannerInstance = new ArmorIQScanner();
      const files = [
        { filename: "vendor/auth.js", patch: "+ const x = 1;" },
        { filename: "package-lock.json", patch: '+ "test": true' },
      ];

      await scannerInstance.scanPullRequest(files, [], [], [], "test-repo", {
        forceInclude: ["vendor/**"],
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const promptContent = mockCreate.mock.calls[0][0].messages[1].content;
      expect(promptContent).toContain("vendor/auth.js");
      expect(promptContent).not.toContain("package-lock.json");
      expect(scannerInstance.lastDefaultSkippedCount).toBe(1);
    });
  });
});

// ─── Model selection ─────────────────────────────────────────────────────────

describe("scan model", () => {
  const original = process.env.AI_MODEL;

  beforeEach(() => {
    mockCreate.mockClear();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AI_MODEL;
    } else {
      process.env.AI_MODEL = original;
    }
  });

  it("resolves an unset or blank AI_MODEL to the default model", () => {
    expect(resolveScanModel(undefined)).toBe("openai/gpt-oss-20b");
    expect(resolveScanModel("")).toBe("openai/gpt-oss-20b");
    expect(resolveScanModel("   ")).toBe("openai/gpt-oss-20b");
    expect(resolveScanModel(" openai/gpt-oss-20b ")).toBe("openai/gpt-oss-20b");
  });

  it("sends the default model when AI_MODEL is unset", async () => {
    delete process.env.AI_MODEL;
    const scannerInstance = new ArmorIQScanner();

    await scannerInstance.scanPullRequest(
      [{ filename: "src/index.ts", patch: "+const x = 5;" }],
      [],
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("openai/gpt-oss-20b");
  });

  it("sends AI_MODEL when it is set", async () => {
    process.env.AI_MODEL = "openai/gpt-oss-20b";
    const scannerInstance = new ArmorIQScanner();

    await scannerInstance.scanPullRequest(
      [{ filename: "src/index.ts", patch: "+const x = 5;" }],
      [],
    );

    expect(mockCreate.mock.calls[0][0].model).toBe("openai/gpt-oss-20b");
  });

  it("detects language and framework and passes them as scan context in prompt (#1925)", async () => {
    const scannerInstance = new ArmorIQScanner();
    const files = [
      {
        filename: "Dockerfile",
        patch: "+FROM alpine:latest\n+RUN apk add curl",
      },
      {
        filename: "infra/main.tf",
        patch: '+resource "aws_s3_bucket" "b" { bucket = "my-bucket" }',
      },
      {
        filename: "src/server.ts",
        patch: '+import express from "express";\n+const app = express();',
      },
      {
        filename: "scripts/backup",
        patch: "+#!/bin/bash\n+echo 'backup'",
      },
      {
        filename: "data.unknownext",
        patch: "+some unknown content",
      },
    ];

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  type: "Vulnerability",
                  severity: "HIGH",
                  description: "Issue in express server",
                  fileLocation: "src/server.ts",
                  codeSnippet: "express()",
                },
                {
                  type: "Misconfig",
                  severity: "LOW",
                  description: "Unknown format issue",
                  fileLocation: "data.unknownext",
                  codeSnippet: "unknown content",
                },
              ],
            }),
          },
        },
      ],
    });

    const findings = await scannerInstance.scanPullRequest(files, []);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const promptContent = mockCreate.mock.calls[0][0].messages[1].content;

    // Verify Dockerfile detected
    expect(promptContent).toContain('<file name="Dockerfile" language="dockerfile"');
    expect(promptContent).toContain("[File Context: Language=dockerfile]");

    // Verify Terraform detected
    expect(promptContent).toContain('<file name="infra/main.tf" language="terraform"');
    expect(promptContent).toContain("[File Context: Language=terraform]");

    // Verify TypeScript and Express framework detected
    expect(promptContent).toContain(
      '<file name="src/server.ts" language="typescript" framework="express"',
    );
    expect(promptContent).toContain("[File Context: Language=typescript, Framework=express]");

    // Verify shebang script detected without extension
    expect(promptContent).toContain('<file name="scripts/backup" language="shell"');
    expect(promptContent).toContain("[File Context: Language=shell]");

    // Verify unknown file does not break scan and passes language="unknown"
    expect(promptContent).toContain('<file name="data.unknownext" language="unknown"');
    expect(promptContent).toContain("[File Context: Language=unknown]");

    // Verify returned findings have language assigned
    expect(findings).toHaveLength(2);
    expect(findings[0].fileLocation).toBe("src/server.ts");
    expect(findings[0].language).toBe("typescript");
    expect(findings[0].framework).toBe("express");

    expect(findings[1].fileLocation).toBe("data.unknownext");
    expect(findings[1].language).toBe("unknown");
  });

  describe("Scanner confidence scoring (#1924)", () => {
    it("parses valid confidence values (HIGH, MEDIUM, LOW) and confidenceReason", async () => {
      const scannerInstance = new ArmorIQScanner();
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Secret",
                    severity: "CRITICAL",
                    confidence: "HIGH",
                    confidenceReason: "Live AWS access key detected in config",
                    description: "Active AWS key",
                    fileLocation: "src/aws.ts",
                    codeSnippet: "key = 'AKIA123'",
                  },
                  {
                    type: "Vulnerability",
                    severity: "MEDIUM",
                    confidence: "LOW",
                    confidenceReason: "Test fixture mock token",
                    description: "Potential test token",
                    fileLocation: "tests/mock.ts",
                    codeSnippet: "token = 'test'",
                  },
                ],
              }),
            },
          },
        ],
      });

      const findings = await scannerInstance.scanPullRequest(
        [{ filename: "src/aws.ts", patch: "+key = 'AKIA123'" }],
        [],
      );

      expect(findings).toHaveLength(2);
      expect(findings[0].confidence).toBe("HIGH");
      expect(findings[0].confidenceReason).toBe("Live AWS access key detected in config");
      expect(findings[1].confidence).toBe("LOW");
      expect(findings[1].confidenceReason).toBe("Test fixture mock token");
    });

    it("defaults safely to MEDIUM when confidence is missing in LLM response", async () => {
      const scannerInstance = new ArmorIQScanner();
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Vulnerability",
                    severity: "HIGH",
                    description: "SQL injection without confidence field",
                    fileLocation: "src/db.ts",
                    codeSnippet: "query()",
                  },
                ],
              }),
            },
          },
        ],
      });

      const findings = await scannerInstance.scanPullRequest(
        [{ filename: "src/db.ts", patch: "+query()" }],
        [],
      );

      expect(findings).toHaveLength(1);
      expect(findings[0].confidence).toBe("MEDIUM");
    });

    it("defaults safely to MEDIUM when confidence is invalid in LLM response", async () => {
      const scannerInstance = new ArmorIQScanner();
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Vulnerability",
                    severity: "HIGH",
                    confidence: "SUPER_HIGH_VERY_SURE",
                    confidenceReason: "Hallucinated confidence level",
                    description: "Issue with invalid confidence",
                    fileLocation: "src/app.ts",
                    codeSnippet: "doWork()",
                  },
                ],
              }),
            },
          },
        ],
      });

      const findings = await scannerInstance.scanPullRequest(
        [{ filename: "src/app.ts", patch: "+doWork()" }],
        [],
      );

      expect(findings).toHaveLength(1);
      expect(findings[0].confidence).toBe("MEDIUM");
      expect(findings[0].confidenceReason).toBe("Hallucinated confidence level");
    });

    it("includes confidence schema and guidance in the prompt sent to LLM", async () => {
      const scannerInstance = new ArmorIQScanner();
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      });

      await scannerInstance.scanPullRequest(
        [{ filename: "src/index.ts", patch: "+const a = 1;" }],
        [],
      );

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const userPrompt = mockCreate.mock.calls[0][0].messages[1].content;
      expect(userPrompt).toContain('"confidence": "HIGH | MEDIUM | LOW"');
      expect(userPrompt).toContain('"confidenceReason":');
      expect(userPrompt).toContain("For confidence: Assign");
    });
  });
});
