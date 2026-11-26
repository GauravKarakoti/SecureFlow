import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  normalizeSeverity,
  calculateHighestSeverity,
  shouldFailBuild,
  parseSarifSummary,
  formatActionCommentBody,
  writeGithubOutputs,
  postOrUpdatePRComment,
  SECUREFLOW_ACTION_MARKER,
} from "./action-runner.js";

describe("SecureFlow GitHub Action Runner (action.yml)", () => {
  describe("Severity normalization & ranking", () => {
    it("normalizes valid and invalid severity strings", () => {
      expect(normalizeSeverity("critical")).toBe("CRITICAL");
      expect(normalizeSeverity("HIGH")).toBe("HIGH");
      expect(normalizeSeverity("Medium")).toBe("MEDIUM");
      expect(normalizeSeverity("low")).toBe("LOW");
      expect(normalizeSeverity("info")).toBe("INFO");
      expect(normalizeSeverity("invalid")).toBe("NONE");
      expect(normalizeSeverity(undefined as any)).toBe("NONE");
    });

    it("identifies highest severity from a collection", () => {
      expect(calculateHighestSeverity(["low", "medium", "high"])).toBe("HIGH");
      expect(calculateHighestSeverity(["low", "critical", "medium"])).toBe("CRITICAL");
      expect(calculateHighestSeverity(["info", "low"])).toBe("LOW");
      expect(calculateHighestSeverity([])).toBe("NONE");
    });
  });

  describe("Build quality gate evaluation (shouldFailBuild)", () => {
    it("fails when highest severity meets or exceeds threshold", () => {
      expect(shouldFailBuild("HIGH", "high")).toBe(true);
      expect(shouldFailBuild("CRITICAL", "high")).toBe(true);
      expect(shouldFailBuild("CRITICAL", "critical")).toBe(true);
      expect(shouldFailBuild("HIGH", "critical")).toBe(false);
      expect(shouldFailBuild("MEDIUM", "high")).toBe(false);
      expect(shouldFailBuild("LOW", "medium")).toBe(false);
      expect(shouldFailBuild("MEDIUM", "medium")).toBe(true);
    });

    it('never fails when fail threshold is "none"', () => {
      expect(shouldFailBuild("CRITICAL", "none")).toBe(false);
      expect(shouldFailBuild("HIGH", "none")).toBe(false);
      expect(shouldFailBuild("NONE", "none")).toBe(false);
    });
  });

  describe("SARIF summary parsing", () => {
    it("parses findings count and highest severity from SARIF 2.1.0 report", () => {
      const sampleSarif = {
        version: "2.1.0",
        runs: [
          {
            results: [
              { ruleId: "rule-1", level: "warning", message: { text: "Medium issue" } },
              { ruleId: "rule-2", level: "error", message: { text: "High issue" } },
              { ruleId: "rule-3", level: "note", message: { text: "Low issue" } },
            ],
          },
        ],
      };

      const summary = parseSarifSummary(sampleSarif);
      expect(summary.totalFindings).toBe(3);
      expect(summary.highestSeverity).toBe("HIGH");
      expect(summary.severities).toEqual(["MEDIUM", "HIGH", "LOW"]);
    });

    it("handles empty or invalid SARIF documents safely", () => {
      expect(parseSarifSummary({ runs: [] }).totalFindings).toBe(0);
      expect(parseSarifSummary("{ bad json").totalFindings).toBe(0);
    });
  });

  describe("Comment body formatting", () => {
    it("formats sticky PR comment with hidden marker, commit SHA, and metric table", () => {
      const body = formatActionCommentBody({
        commitSha: "a1b2c3d4e5f6",
        scanTime: "2026-11-25T22:30:00Z",
        totalFindings: 2,
        highestSeverity: "HIGH",
        failThreshold: "high",
        failed: true,
        reportPath: "secureflow-results.sarif",
      });

      expect(body).toContain(SECUREFLOW_ACTION_MARKER);
      expect(body).toContain("### 🛡️ SecureFlow Security Report");
      expect(body).toContain("Scanned commit: `a1b2c3d4e5f6`");
      expect(body).toContain("Scan time: `2026-11-25T22:30:00Z`");
      expect(body).toContain("| **Total Findings** | `2` |");
      expect(body).toContain("| **Highest Severity** | `HIGH` |");
      expect(body).toContain("| **Fail Threshold** | `HIGH` |");
      expect(body).toContain("❌ Failed");
      expect(body).toContain("secureflow-results.sarif");
    });

    it("formats clean success message when zero findings exist", () => {
      const body = formatActionCommentBody({
        commitSha: "123456",
        scanTime: "2026-11-25T22:30:00Z",
        totalFindings: 0,
        highestSeverity: "NONE",
        failThreshold: "high",
        failed: false,
      });

      expect(body).toContain("✅ Passed");
      expect(body).toContain("No security vulnerabilities or secret leaks detected");
    });
  });

  describe("GitHub step outputs", () => {
    let tempFile: string;

    beforeEach(() => {
      tempFile = path.join(os.tmpdir(), `github-output-${Date.now()}.txt`);
      process.env.GITHUB_OUTPUT = tempFile;
    });

    afterEach(() => {
      delete process.env.GITHUB_OUTPUT;
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });

    it("writes key-value step outputs to $GITHUB_OUTPUT file", () => {
      writeGithubOutputs({
        "total-findings": 3,
        "highest-severity": "HIGH",
        "has-findings": "true",
        "sarif-file": "secureflow-results.sarif",
      });

      const content = fs.readFileSync(tempFile, "utf-8");
      expect(content).toContain("total-findings=3\n");
      expect(content).toContain("highest-severity=HIGH\n");
      expect(content).toContain("has-findings=true\n");
      expect(content).toContain("sarif-file=secureflow-results.sarif\n");
    });
  });

  describe("Pull request sticky comment API", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("updates existing comment if comment with marker already exists", async () => {
      const fetchMock = vi
        .fn()
        // 1. GET listComments
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ id: 99, body: `${SECUREFLOW_ACTION_MARKER}\nOld report` }],
        })
        // 2. PATCH updateComment
        .mockResolvedValueOnce({
          ok: true,
        });

      globalThis.fetch = fetchMock;

      const success = await postOrUpdatePRComment({
        token: "ghp_secret",
        repository: "owner/repo",
        prNumber: 42,
        body: "Updated comment",
      });

      expect(success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain("/issues/comments/99");
      expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
    });

    it("creates a new comment if none exists", async () => {
      const fetchMock = vi
        .fn()
        // 1. GET listComments returns empty
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        })
        // 2. POST createComment
        .mockResolvedValueOnce({
          ok: true,
        });

      globalThis.fetch = fetchMock;

      const success = await postOrUpdatePRComment({
        token: "ghp_secret",
        repository: "owner/repo",
        prNumber: 42,
        body: "New comment",
      });

      expect(success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain("/issues/42/comments");
      expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    });
  });
});
