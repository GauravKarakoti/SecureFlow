/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScanComparisonView } from "./scan-comparison-view";
import type { ScanComparisonResult } from "@/lib/scans/comparison";

describe("ScanComparisonView Component (#1923)", () => {
  const mockScans = [
    {
      id: "scan-2",
      headSha: "sha2222222",
      createdAt: new Date("2026-11-22T10:00:00Z").toISOString(),
      findingsCount: 3,
      riskScore: 20,
      policyDecision: "PASS",
    },
    {
      id: "scan-1",
      headSha: "sha1111111",
      createdAt: new Date("2026-11-22T09:00:00Z").toISOString(),
      findingsCount: 2,
      riskScore: 15,
      policyDecision: "BLOCK",
    },
  ];

  const mockComparableResult: ScanComparisonResult = {
    isComparable: true,
    baseScan: {
      id: "scan-1",
      headSha: "sha1111111",
      createdAt: "2026-11-22T09:00:00Z",
    },
    targetScan: {
      id: "scan-2",
      headSha: "sha2222222",
      createdAt: "2026-11-22T10:00:00Z",
    },
    summary: {
      newCount: 1,
      fixedCount: 1,
      unchangedCount: 1,
      newSeverityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      fixedSeverityCounts: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 },
      unchangedSeverityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
    },
    groups: {
      new: {
        status: "NEW",
        count: 1,
        severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        findings: [
          {
            id: "f-new",
            fingerprint: "fp-new",
            type: "Secret",
            severity: "HIGH",
            fileLocation: "src/auth.ts",
            lineStart: 12,
            codeSnippet: "const token = 'xyz';",
            explanation: "Hardcoded secret token in auth",
          },
        ],
      },
      fixed: {
        status: "FIXED",
        count: 1,
        severityCounts: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 },
        findings: [
          {
            id: "f-fixed",
            fingerprint: "fp-fixed",
            type: "Vulnerability",
            severity: "CRITICAL",
            fileLocation: "src/db.ts",
            lineStart: 45,
            codeSnippet: "db.query(`SELECT ${input}`)",
            explanation: "SQL injection flaw fixed",
          },
        ],
      },
      unchanged: {
        status: "UNCHANGED",
        count: 1,
        severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
        findings: [
          {
            id: "f-unchanged",
            fingerprint: "fp-unchanged",
            type: "Misconfig",
            severity: "MEDIUM",
            fileLocation: "Dockerfile",
            lineStart: 1,
            codeSnippet: "USER root",
            explanation: "Root user in container",
          },
        ],
      },
    },
  };

  it("renders dropdown selectors with all scans and default selections", () => {
    render(
      <ScanComparisonView
        pullRequestId="pr-1"
        initialComparison={mockComparableResult}
        scans={mockScans}
      />,
    );

    const baseSelect = screen.getByLabelText(/Base Scan/i) as HTMLSelectElement;
    const targetSelect = screen.getByLabelText(/Target Scan/i) as HTMLSelectElement;

    expect(baseSelect.value).toBe("scan-1");
    expect(targetSelect.value).toBe("scan-2");
    expect(baseSelect.options).toHaveLength(2);
  });

  it("renders metric cards and finding details when comparable", () => {
    render(
      <ScanComparisonView
        pullRequestId="pr-1"
        initialComparison={mockComparableResult}
        scans={mockScans}
      />,
    );

    expect(screen.getByText("New Findings")).toBeInTheDocument();
    expect(screen.getByText("Fixed Findings")).toBeInTheDocument();
    expect(screen.getByText("Unchanged Findings")).toBeInTheDocument();

    // Verify finding details rendered
    expect(screen.getByText("src/auth.ts:12")).toBeInTheDocument();
    expect(screen.getByText("Hardcoded secret token in auth")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view finding/i })).toHaveAttribute(
      "href",
      "/dashboard/findings/f-new",
    );
  });

  it("renders clear not-comparable alert when scan is failed or partial", () => {
    const notComparableResult: ScanComparisonResult = {
      isComparable: false,
      incomparableReason: "Target scan is a partial scan (some files were skipped) and cannot be compared.",
      baseScan: { id: "scan-1", headSha: "sha111", createdAt: "2026-11-22T09:00:00Z" },
      targetScan: { id: "scan-2", headSha: "sha222", createdAt: "2026-11-22T10:00:00Z", isPartial: true },
      summary: {
        newCount: 0,
        fixedCount: 0,
        unchangedCount: 0,
        newSeverityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        fixedSeverityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        unchangedSeverityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      },
      groups: {
        new: { status: "NEW", count: 0, severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, findings: [] },
        fixed: { status: "FIXED", count: 0, severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, findings: [] },
        unchanged: { status: "UNCHANGED", count: 0, severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, findings: [] },
      },
    };

    render(
      <ScanComparisonView
        pullRequestId="pr-1"
        initialComparison={notComparableResult}
        scans={mockScans}
      />,
    );

    expect(screen.getByTestId("not-comparable-card")).toBeInTheDocument();
    expect(screen.getByText("Scans Not Comparable")).toBeInTheDocument();
    expect(
      screen.getByText(/Target scan is a partial scan \(some files were skipped\)/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("comparison-results")).not.toBeInTheDocument();
  });

  it("fetches updated comparison when dropdown selection changes", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockComparableResult,
    } as any);

    render(
      <ScanComparisonView
        pullRequestId="pr-1"
        initialComparison={null}
        scans={mockScans}
      />,
    );

    const baseSelect = screen.getByLabelText(/Base Scan/i);
    fireEvent.change(baseSelect, { target: { value: "scan-2" } });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/scans/compare?pullRequestId=pr-1&baseScanId=scan-2"),
      );
    });

    fetchSpy.mockRestore();
  });
});
