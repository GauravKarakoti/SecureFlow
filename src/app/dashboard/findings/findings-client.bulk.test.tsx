/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import FindingsClient from "./findings-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard/findings",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("react-countup", () => ({
  default: ({ end }: { end: number }) => <span>{end}</span>,
}));

vi.mock("@/components/streaming-explanation", () => ({
  default: () => <div data-testid="streaming-explanation">Explanation</div>,
}));

// Both exports: the single-finding control and the bulk bar (#732).
vi.mock("./finding-triage-controls", () => ({
  default: () => <div data-testid="triage-controls">Triage Controls</div>,
  BulkTriageBar: ({ targets }: { targets: unknown[] }) => (
    <div data-testid="bulk-triage-bar">Bulk bar: {targets.length}</div>
  ),
}));

// Expose the bulk-mode toggle so the test can drive selection mode.
vi.mock("./findings-toolbar", () => ({
  default: ({
    onToggleBulkMode,
    bulkMode,
    canBulkSelect,
  }: {
    onToggleBulkMode?: () => void;
    bulkMode?: boolean;
    canBulkSelect?: boolean;
  }) => (
    <div data-testid="findings-toolbar">
      {canBulkSelect && (
        <button onClick={onToggleBulkMode}>
          {bulkMode ? "Cancel bulk select" : "Bulk select"}
        </button>
      )}
    </div>
  ),
}));

const mockStats = { criticalSecrets: 1, vulnerabilities: 1, misconfigs: 0, other: 0 };

const mockFindings: any[] = [
  {
    id: "f-1",
    type: "SECRET",
    severity: "CRITICAL",
    fileLocation: "src/config/keys.ts",
    codeSnippet: "x",
    explanation: "e",
    remediation: "r",
    promptInjectionSuspected: false,
    repositoryId: "repo-1",
    fingerprint: "fp-1",
    triageStatus: "OPEN",
  },
  {
    id: "f-2",
    type: "VULNERABILITY",
    severity: "HIGH",
    fileLocation: "src/auth/token.ts",
    codeSnippet: "y",
    explanation: "e",
    remediation: "r",
    promptInjectionSuspected: false,
    repositoryId: "repo-1",
    fingerprint: "fp-2",
    triageStatus: "OPEN",
  },
];

const defaultProps = {
  findings: mockFindings,
  stats: mockStats,
  total: 2,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  filterOptions: { repositories: [], types: [], severities: [] },
};

describe("FindingsClient bulk triage (#732)", () => {
  it("hides selection checkboxes until bulk mode is enabled", () => {
    render(<FindingsClient {...defaultProps} />);
    // No per-finding selection checkboxes and no bulk bar before entering mode.
    expect(screen.queryByLabelText(/Select finding in/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("bulk-triage-bar")).not.toBeInTheDocument();
  });

  it("shows checkboxes and a select-all control once bulk mode is on", () => {
    render(<FindingsClient {...defaultProps} />);
    fireEvent.click(screen.getByText("Bulk select"));

    expect(screen.getByLabelText("Select all findings on this page")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Select finding in/)).toHaveLength(2);
    // Nothing selected yet, so no bulk action bar.
    expect(screen.queryByTestId("bulk-triage-bar")).not.toBeInTheDocument();
  });

  it("reveals the bulk action bar with the selected count when findings are picked", () => {
    render(<FindingsClient {...defaultProps} />);
    fireEvent.click(screen.getByText("Bulk select"));

    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    const bar = screen.getByTestId("bulk-triage-bar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveTextContent("Bulk bar: 2");
  });
});
