import { describe, it, expect } from "vitest";
import {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_CONTENT_LENGTH,
  MAX_PATH_LENGTH,
  MAX_SCAN_REQUEST_BYTES,
  cliScanRequestSchema,
  cliScanResponseSchema,
  stagedFileForAiScanSchema,
  aiFindingSchema,
} from "./index.js";

describe("Shared CLI API Contracts (#1696)", () => {
  it("exports expected limits and boundaries", () => {
    expect(MAX_FILES_PER_REQUEST).toBe(100);
    expect(MAX_FILE_CONTENT_LENGTH).toBe(512 * 1024);
    expect(MAX_PATH_LENGTH).toBe(1024);
    expect(MAX_SCAN_REQUEST_BYTES).toBe(10 * 1024 * 1024);
  });

  describe("stagedFileForAiScanSchema", () => {
    it("validates a valid staged file", () => {
      const valid = { path: "src/index.ts", content: "console.log('hi');" };
      const res = stagedFileForAiScanSchema.safeParse(valid);
      expect(res.success).toBe(true);
    });

    it("rejects empty path", () => {
      const invalid = { path: "", content: "abc" };
      const res = stagedFileForAiScanSchema.safeParse(invalid);
      expect(res.success).toBe(false);
    });

    it("rejects path exceeding MAX_PATH_LENGTH", () => {
      const invalid = { path: "a".repeat(MAX_PATH_LENGTH + 1), content: "abc" };
      const res = stagedFileForAiScanSchema.safeParse(invalid);
      expect(res.success).toBe(false);
    });

    it("rejects file content exceeding MAX_FILE_CONTENT_LENGTH", () => {
      const invalid = {
        path: "large.txt",
        content: "x".repeat(MAX_FILE_CONTENT_LENGTH + 1),
      };
      const res = stagedFileForAiScanSchema.safeParse(invalid);
      expect(res.success).toBe(false);
    });
  });

  describe("cliScanRequestSchema", () => {
    it("validates valid request with optional flags", () => {
      const valid = {
        files: [{ path: "app.ts", content: "export default {};" }],
        voice: true,
        summaryText: "Scan summary",
      };
      const res = cliScanRequestSchema.safeParse(valid);
      expect(res.success).toBe(true);
    });

    it("rejects empty files array", () => {
      const invalid = { files: [] };
      const res = cliScanRequestSchema.safeParse(invalid);
      expect(res.success).toBe(false);
    });

    it("rejects requests exceeding MAX_FILES_PER_REQUEST", () => {
      const files = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => ({
        path: `file_${i}.ts`,
        content: "test",
      }));
      const res = cliScanRequestSchema.safeParse({ files });
      expect(res.success).toBe(false);
    });
  });

  describe("cliScanResponseSchema & aiFindingSchema", () => {
    it("validates valid scan response with findings", () => {
      const valid = {
        findings: [
          {
            type: "SECRET_LEAK",
            severity: "HIGH",
            description: "Exposed API token",
            fileLocation: "config.ts",
            codeSnippet: "API_KEY = 'secret'",
            lineStart: 10,
            lineEnd: 10,
          },
        ],
        audioBase64: "dGVzdA==",
      };
      const res = cliScanResponseSchema.safeParse(valid);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.findings).toHaveLength(1);
        expect(res.data.audioBase64).toBe("dGVzdA==");
      }
    });

    it("defaults findings to empty array when findings key is missing", () => {
      const res = cliScanResponseSchema.safeParse({});
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.findings).toEqual([]);
      }
    });

    it("rejects invalid severity", () => {
      const invalidFinding = {
        type: "SECRET_LEAK",
        severity: "UNKNOWN",
        description: "Exposed API token",
        fileLocation: "config.ts",
        codeSnippet: "API_KEY = 'secret'",
      };
      const res = aiFindingSchema.safeParse(invalidFinding);
      expect(res.success).toBe(false);
    });
  });
});
