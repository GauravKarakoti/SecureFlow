import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockCreate } from "../../../__mocks__/groq-sdk";

import {
  scanner,
  resolveDiffChunkMaxChars,
  resolveDiffFileMaxChars,
  DEFAULT_DIFF_CHUNK_MAX_CHARS,
  DEFAULT_DIFF_FILE_MAX_CHARS,
  type FileChange,
} from "./scanner";

describe("Diff chunking & size limits configuration", () => {
  it("resolves default values when environment variables are unset", () => {
    expect(resolveDiffChunkMaxChars(undefined)).toBe(DEFAULT_DIFF_CHUNK_MAX_CHARS);
    expect(resolveDiffFileMaxChars(undefined)).toBe(DEFAULT_DIFF_FILE_MAX_CHARS);
  });

  it("resolves configured values from parameters or env", () => {
    expect(resolveDiffChunkMaxChars("10000")).toBe(10000);
    expect(resolveDiffFileMaxChars("25000")).toBe(25000);
  });

  it("falls back to default on invalid or negative input", () => {
    expect(resolveDiffChunkMaxChars("-50")).toBe(DEFAULT_DIFF_CHUNK_MAX_CHARS);
    expect(resolveDiffChunkMaxChars("abc")).toBe(DEFAULT_DIFF_CHUNK_MAX_CHARS);
    expect(resolveDiffFileMaxChars("0")).toBe(DEFAULT_DIFF_FILE_MAX_CHARS);
  });
});

describe("scanner.scanPullRequest chunking and skipped files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ findings: [] }),
          },
        },
      ],
    });
  });

  it("scans small diffs without chunk overflow or skipped files", async () => {
    const files: FileChange[] = [
      {
        filename: "src/a.ts",
        patch: "@@ -0,0 +1,5 @@\n+const x = 1;\n+const y = 2;",
      },
      {
        filename: "src/b.ts",
        patch: "@@ -0,0 +1,5 @@\n+const z = 3;",
      },
    ];

    const findings = await scanner.scanPullRequest(files);
    expect(findings).toEqual([]);
    expect(scanner.lastSkippedFiles).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("splits large diffs exceeding chunk limit into multiple LLM calls and merges findings", async () => {
    // Override chunk limit to a small size
    vi.stubEnv("DIFF_CHUNK_MAX_CHARS", "500");

    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Vulnerability",
                    severity: "HIGH",
                    description: "Issue in file 1",
                    fileLocation: "src/file1.ts",
                    codeSnippet: "vulnerable code 1",
                    lineStart: 1,
                    lineEnd: 2,
                  },
                ],
              }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Vulnerability",
                    severity: "MEDIUM",
                    description: "Issue in file 2",
                    fileLocation: "src/file2.ts",
                    codeSnippet: "vulnerable code 2",
                    lineStart: 1,
                    lineEnd: 2,
                  },
                ],
              }),
            },
          },
        ],
      });

    // Each patch has ~350 characters of added lines, exceeding 500 chars when combined
    const patchContent = "+console.log('padding to increase diff length');\n".repeat(10);
    const files: FileChange[] = [
      {
        filename: "src/file1.ts",
        patch: `@@ -0,0 +1,10 @@\n${patchContent}`,
      },
      {
        filename: "src/file2.ts",
        patch: `@@ -0,0 +1,10 @@\n${patchContent}`,
      },
    ];

    const findings = await scanner.scanPullRequest(files);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.fileLocation)).toEqual(["src/file1.ts", "src/file2.ts"]);
    expect(scanner.lastSkippedFiles).toEqual([]);
  });

  it("tracks oversized single files in lastSkippedFiles and does not send them to LLM", async () => {
    // Set max file limit to 200 chars
    vi.stubEnv("DIFF_FILE_MAX_CHARS", "200");

    const hugePatch = "+console.log('overflow');\n".repeat(20); // > 400 chars
    const normalPatch = "+const ok = true;\n";

    const files: FileChange[] = [
      {
        filename: "src/huge.ts",
        patch: `@@ -0,0 +1,20 @@\n${hugePatch}`,
      },
      {
        filename: "src/normal.ts",
        patch: `@@ -0,0 +1,2 @@\n${normalPatch}`,
      },
    ];

    const findings = await scanner.scanPullRequest(files);
    expect(findings).toEqual([]);
    expect(scanner.lastSkippedFiles).toEqual([
      { filename: "src/huge.ts", reason: "oversized" },
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const promptArg = mockCreate.mock.calls[0][0].messages[1].content;
    expect(promptArg).toContain("src/normal.ts");
    expect(promptArg).not.toContain("src/huge.ts");
  });
});
