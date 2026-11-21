/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PolicyEditModal } from "./policy-edit-modal";

const mockToast = vi.hoisted(() => vi.fn());
const mockEditPolicy = vi.hoisted(() => vi.fn());
const mockPreviewPolicyImpactAction = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("./actions", () => ({
  editPolicy: mockEditPolicy,
  previewPolicyImpactAction: mockPreviewPolicyImpactAction,
}));

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("PolicyEditModal - Preview Impact (#1892)", () => {
  const defaultProps = {
    policyId: "tpl-1",
    policyName: "Block Secrets",
    currentDescription: "Block hardcoded secrets and tokens in PR code changes",
    currentSeverity: "HIGH",
    isOpen: true,
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Preview Impact button", () => {
    render(<PolicyEditModal {...defaultProps} />);
    expect(screen.getByTestId("preview-impact-button")).toBeInTheDocument();
  });

  it("disables Preview Impact button when description is empty", async () => {
    render(<PolicyEditModal {...defaultProps} currentDescription="" />);
    const previewBtn = screen.getByTestId("preview-impact-button");
    expect(previewBtn).toBeDisabled();
  });

  it("shows a clear message when too little history exists", async () => {
    mockPreviewPolicyImpactAction.mockResolvedValueOnce({
      ok: true,
      hasHistory: false,
      message:
        "Too little history exists for a meaningful preview. Run repository scans to generate historical scan data.",
      replayedScans: 0,
      totalTokens: 0,
      severityComparison: {
        CRITICAL: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        HIGH: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        MEDIUM: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        LOW: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        INFO: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        TOTAL: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
      },
      findings: { new: [], removed: [], unchanged: [] },
    });

    render(<PolicyEditModal {...defaultProps} />);
    const previewBtn = screen.getByTestId("preview-impact-button");
    await userEvent.click(previewBtn);

    await waitFor(() => {
      expect(screen.getByTestId("preview-empty-history")).toBeInTheDocument();
    });

    expect(
      screen.getAllByText(/Too little history exists for a meaningful preview/i).length,
    ).toBeGreaterThan(0);
  });

  it("renders comparison table and findings breakdown when history exists", async () => {
    mockPreviewPolicyImpactAction.mockResolvedValueOnce({
      ok: true,
      hasHistory: true,
      replayedScans: 8,
      totalTokens: 4200,
      severityComparison: {
        CRITICAL: { unchanged: 0, newCount: 1, removedCount: 0, netChange: 1 },
        HIGH: { unchanged: 3, newCount: 0, removedCount: 1, netChange: -1 },
        MEDIUM: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        LOW: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        INFO: { unchanged: 0, newCount: 0, removedCount: 0, netChange: 0 },
        TOTAL: { unchanged: 3, newCount: 1, removedCount: 1, netChange: 0 },
      },
      findings: {
        new: [
          {
            type: "Secret",
            severity: "CRITICAL",
            description: "Hardcoded production private key in config.ts",
            fileLocation: "config.ts",
            lineStart: 12,
            status: "NEW",
          },
        ],
        removed: [
          {
            type: "Secret",
            severity: "HIGH",
            description: "Old secret format no longer flagged",
            fileLocation: "api.ts",
            lineStart: 5,
            status: "REMOVED",
          },
        ],
        unchanged: [],
      },
    });

    render(<PolicyEditModal {...defaultProps} />);
    const previewBtn = screen.getByTestId("preview-impact-button");
    await userEvent.click(previewBtn);

    await waitFor(() => {
      expect(screen.getByTestId("preview-impact-result")).toBeInTheDocument();
      expect(screen.getByTestId("severity-comparison-table")).toBeInTheDocument();
    });

    expect(screen.getByText(/8 scans replayed/i)).toBeInTheDocument();
    expect(screen.getByText("Hardcoded production private key in config.ts")).toBeInTheDocument();
    expect(screen.getByText("Old secret format no longer flagged")).toBeInTheDocument();
  });
});
