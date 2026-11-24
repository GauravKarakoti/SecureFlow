import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockCreate } from "../../../__mocks__/groq-sdk";
import {
  scanner,
  filterFindingsToChangedLines,
  type FileChange,
  type ScanFinding,
} from "./scanner";
import { patch } from "../../../tests/helpers"; // or construct patch string

const makePatch = (...lines: string[]) => lines.join("\n");

describe("scanner diff context lines and changed line enforcement (#2006)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe("filterFindingsToChangedLines", () => {
    const testPatch = makePatch(
      "@@ -10,7 +10,7 @@",
      " const apiKey = process.env.API_KEY;",
      " const client = new Client(apiKey);",
      " const safe = sanitize(input);",
      "-const oldVal = 1;",
      "+const newVal = eval(input);",
      " const x = 2;",
      " const y = 3;",
    );
    const files: FileChange[] = [{ filename: "src/eval.ts", patch: testPatch }];

    it("keeps findings on changed/added lines", () => {
      const findings: ScanFinding[] = [
        {
          type: "Vulnerability",
          severity: "HIGH",
          description: "Dangerous eval",
          fileLocation: "src/eval.ts",
          codeSnippet: "const newVal = eval(input);",
          lineStart: 13,
          lineEnd: 13,
        },
      ];

      const filtered = filterFindingsToChangedLines(findings, files);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].lineStart).toBe(13);
    });

    it("filters out findings that fall on unchanged context lines", () => {
      const findings: ScanFinding[] = [
        {
          type: "Secret",
          severity: "HIGH",
          description: "API Key in context",
          fileLocation: "src/eval.ts",
          codeSnippet: "const apiKey = process.env.API_KEY;",
          lineStart: 10,
          lineEnd: 10,
        },
        {
          type: "Vulnerability",
          severity: "LOW",
          description: "Trailing context",
          fileLocation: "src/eval.ts",
          codeSnippet: "const y = 3;",
          lineStart: 15,
          lineEnd: 15,
        },
      ];

      const filtered = filterFindingsToChangedLines(findings, files);
      expect(filtered).toHaveLength(0);
    });

    it("adjusts multi-line findings spanning from context into changed lines to start at the changed line", () => {
      const findings: ScanFinding[] = [
        {
          type: "Vulnerability",
          severity: "HIGH",
          description: "Block with eval",
          fileLocation: "src/eval.ts",
          codeSnippet: "const safe = sanitize(input);\nconst newVal = eval(input);",
          lineStart: 12, // context line
          lineEnd: 13, // changed line
        },
      ];

      const filtered = filterFindingsToChangedLines(findings, files);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].lineStart).toBe(13); // Clamped to first changed line
    });

    it("preserves findings for files without patch info", () => {
      const findings: ScanFinding[] = [
        {
          type: "Vulnerability",
          severity: "HIGH",
          description: "File without patch",
          fileLocation: "src/unknown.ts",
          codeSnippet: "vulnerable()",
          lineStart: 5,
        },
      ];

      const filtered = filterFindingsToChangedLines(findings, files);
      expect(filtered).toHaveLength(1);
    });
  });

  describe("scanner.scanPullRequest with contextLines", () => {
    it("passes marked [CHANGED] and [UNCHANGED CONTEXT] lines to the model prompt", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Vulnerability",
                    severity: "HIGH",
                    description: "Dangerous eval",
                    fileLocation: "src/eval.ts",
                    codeSnippet: "const newVal = eval(input);",
                    lineStart: 13,
                    lineEnd: 13,
                  },
                ],
              }),
            },
          },
        ],
      });

      const testPatch = makePatch(
        "@@ -10,7 +10,7 @@",
        " const apiKey = process.env.API_KEY;",
        " const client = new Client(apiKey);",
        " const safe = sanitize(input);",
        "-const oldVal = 1;",
        "+const newVal = eval(input);",
        " const x = 2;",
        " const y = 3;",
      );

      const files: FileChange[] = [{ filename: "src/eval.ts", patch: testPatch }];

      const findings = await scanner.scanPullRequest(files, [], [], [], "test-repo", undefined, {
        contextLines: 2,
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const promptArg = mockCreate.mock.calls[0][0].messages[1].content;

      // Unchanged context lines within 2 lines of change are included with marker
      expect(promptArg).toContain("[UNCHANGED CONTEXT] const safe = sanitize(input);");
      expect(promptArg).toContain("[CHANGED] const newVal = eval(input);");
      expect(promptArg).toContain("[UNCHANGED CONTEXT] const x = 2;");

      // Context line beyond 2 lines away is NOT included
      expect(promptArg).not.toContain("const apiKey = process.env.API_KEY;");

      // Valid finding on changed line is retained
      expect(findings).toHaveLength(1);
      expect(findings[0].lineStart).toBe(13);
    });

    it("filters out hallucinated findings on unchanged context lines returned by the LLM", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    type: "Secret",
                    severity: "CRITICAL",
                    description: "Context leak",
                    fileLocation: "src/eval.ts",
                    codeSnippet: "const safe = sanitize(input);",
                    lineStart: 12, // Unchanged context line!
                    lineEnd: 12,
                  },
                ],
              }),
            },
          },
        ],
      });

      const testPatch = makePatch(
        "@@ -10,7 +10,7 @@",
        " const apiKey = process.env.API_KEY;",
        " const client = new Client(apiKey);",
        " const safe = sanitize(input);",
        "-const oldVal = 1;",
        "+const newVal = eval(input);",
        " const x = 2;",
        " const y = 3;",
      );

      const files: FileChange[] = [{ filename: "src/eval.ts", patch: testPatch }];

      const findings = await scanner.scanPullRequest(files);
      // Finding on unchanged context line must be filtered out!
      expect(findings).toHaveLength(0);
    });

    it("accounts for context lines in chunking size and splits batches accordingly", async () => {
      // Small chunk max
      vi.stubEnv("DIFF_CHUNK_MAX_CHARS", "600");

      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({ findings: [] }),
            },
          },
        ],
      });

      // Patch with 5 context lines before and 5 after
      const patchWithContext = makePatch(
        "@@ -1,11 +1,11 @@",
        " context line 1 - extra padding to increase size",
        " context line 2 - extra padding to increase size",
        " context line 3 - extra padding to increase size",
        " context line 4 - extra padding to increase size",
        " context line 5 - extra padding to increase size",
        "+added line 1 - some change",
        " context line 6 - extra padding to increase size",
        " context line 7 - extra padding to increase size",
        " context line 8 - extra padding to increase size",
        " context line 9 - extra padding to increase size",
        " context line 10 - extra padding to increase size",
      );

      const files: FileChange[] = [
        { filename: "src/fileA.ts", patch: patchWithContext },
        { filename: "src/fileB.ts", patch: patchWithContext },
      ];

      // With contextLines = 0, diffs are small and fit in 1 batch
      await scanner.scanPullRequest(files, [], [], [], "repo", undefined, { contextLines: 0 });
      expect(mockCreate).toHaveBeenCalledTimes(1);

      mockCreate.mockClear();

      // With contextLines = 5, extra context lines push size over 600 chars, splitting into 2 batches
      await scanner.scanPullRequest(files, [], [], [], "repo", undefined, { contextLines: 5 });
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });
});
