/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: mockToast,
    toasts: [],
    dismiss: vi.fn(),
  }),
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

const mockHomogeneousFindings: any[] = [
  {
    id: "f-2",
    type: "VULNERABILITY",
    severity: "HIGH",
    fileLocation: "src/auth/token.ts",
    codeSnippet: "jwt.decode(token)",
    explanation: "Unverified token decode",
    remediation: "Verify signature with jwt.verify",
    promptInjectionSuspected: false,
    repositoryId: "repo-1",
    fingerprint: "fp-2",
    triageStatus: "OPEN",
  },
  {
    id: "f-3",
    type: "VULNERABILITY",
    severity: "CRITICAL",
    fileLocation: "src/auth/session.ts",
    codeSnippet: "session.id = req.query.id",
    explanation: "Session fixation vulnerability",
    remediation: "Regenerate session id",
    promptInjectionSuspected: false,
    repositoryId: "repo-1",
    fingerprint: "fp-3",
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

describe("FindingsClient bulk remediation (#814)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks bulk remediation and shows warning when mixed vulnerability types are selected", () => {
    render(<FindingsClient {...defaultProps} />);
    fireEvent.click(screen.getByText("Bulk select"));

    // Select both findings (one SECRET, one VULNERABILITY)
    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    // Both bars should render
    expect(screen.getByTestId("bulk-triage-bar")).toHaveTextContent("Bulk bar: 2");
    expect(screen.getByTestId("bulk-remediation-bar")).toBeInTheDocument();

    // Homogeneity warning must be present
    expect(screen.getByTestId("bulk-remediation-mixed-warning")).toBeInTheDocument();
    expect(screen.getByText(/Mixed vulnerability types selected/i)).toBeInTheDocument();
    expect(screen.getByText(/SECRET, VULNERABILITY/i)).toBeInTheDocument();

    // Generate button must be disabled
    const generateBtn = screen.getByTestId("generate-bulk-patch-button");
    expect(generateBtn).toBeDisabled();
  });

  it("enables bulk remediation when multiple findings of the same vulnerability type are selected", () => {
    render(<FindingsClient {...defaultProps} findings={mockHomogeneousFindings} />);
    fireEvent.click(screen.getByText("Bulk select"));

    // Select both findings (both VULNERABILITY)
    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    expect(screen.getByTestId("bulk-remediation-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("bulk-remediation-mixed-warning")).not.toBeInTheDocument();
    expect(screen.getByText("2 VULNERABILITY")).toBeInTheDocument();

    // Generate button must be enabled
    const generateBtn = screen.getByTestId("generate-bulk-patch-button");
    expect(generateBtn).not.toBeDisabled();
  });

  it("generates a bulk remediation patch and displays the review diff viewer", async () => {
    const mockDiff =
      "--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n@@ -1 +1 @@\n-jwt.decode(token)\n+jwt.verify(token, secret)\n\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-session.id = req.query.id\n+session.regenerate()";
    const mockExplanation = "Applied secure verification and session regeneration across 2 files.";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        patch: { patchDiff: mockDiff, status: "GENERATED" },
        explanation: mockExplanation,
      }),
    });
    global.fetch = mockFetch;

    render(<FindingsClient {...defaultProps} findings={mockHomogeneousFindings} />);
    fireEvent.click(screen.getByText("Bulk select"));
    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    const generateBtn = screen.getByTestId("generate-bulk-patch-button");
    fireEvent.click(generateBtn);

    // Verify endpoint was called with the selected finding IDs
    expect(mockFetch).toHaveBeenCalledWith("/api/findings/bulk-remediate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findingIds: ["f-2", "f-3"] }),
    });

    // Await review interface
    await waitFor(() => {
      expect(screen.getByTestId("bulk-patch-review")).toBeInTheDocument();
    });

    expect(screen.getByText(mockExplanation)).toBeInTheDocument();
    expect(screen.getByText(/git apply/)).toBeInTheDocument();

    // Verify close functionality
    fireEvent.click(screen.getByText("Close Diff"));
    expect(screen.queryByTestId("bulk-patch-review")).not.toBeInTheDocument();
  });

  it("handles bulk remediation generation errors gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "AI generation quota exceeded. Please try again later.",
      }),
    });
    global.fetch = mockFetch;

    render(<FindingsClient {...defaultProps} findings={mockHomogeneousFindings} />);
    fireEvent.click(screen.getByText("Bulk select"));
    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));

    await waitFor(() => {
      expect(
        screen.getByText("AI generation quota exceeded. Please try again later."),
      ).toBeInTheDocument();
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "destructive",
        title: "Remediation Failed",
      }),
    );
  });
});
