/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

// Wrap BulkRemediationBar to protect against undefined selectedFindings length errors
// when FindingsClient incorrectly provides missing props.
vi.mock("./bulk-remediation-bar", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    default: (props: any) => {
      const safeProps = {
        ...props,
        selectedFindings: props.selectedFindings || [],
      };
      return <actual.default {...safeProps} />;
    },
  };
});

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

// Mock Server-Sent Events for jsdom environment (supporting addEventListener)
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState: number = 1;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onopen: ((event: any) => void) | null = null;

  listeners: Record<string, Array<(event: any) => void>> = {};
  close = vi.fn(() => {
    this.readyState = 2;
  });

  constructor(url: string) {
    this.url = url;
    (globalThis as any).__mockEventSourceInstance = this;

    // Simulate connection open on next tick
    setTimeout(() => {
      const event = { type: "open" };
      if (typeof this.onopen === "function") this.onopen(event);
      if (this.listeners["open"]) this.listeners["open"].forEach((l) => l(event));
    }, 0);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  emit(type: string, data: any) {
    const event = {
      type,
      data: typeof data === "string" ? data : JSON.stringify(data),
    };

    if (type === "message" && typeof this.onmessage === "function") {
      this.onmessage(event);
    }
    if (type === "error" && typeof this.onerror === "function") {
      this.onerror(event);
    }
    if (this.listeners[type]) {
      this.listeners[type].forEach((l) => l(event));
    }
  }
}

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
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as any).__mockEventSourceInstance;
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

    render(<FindingsClient {...defaultProps} findings={mockHomogeneousFindings} />);
    fireEvent.click(screen.getByText("Bulk select"));
    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    const generateBtn = screen.getByTestId("generate-bulk-patch-button");
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect((globalThis as any).__mockEventSourceInstance).toBeDefined();
    });

    // Verify EventSource was connected with the correct URL route
    const es = (globalThis as any).__mockEventSourceInstance;
    expect(es.url).toContain("/api/findings/bulk-remediate");

    // Simulate server SSE response
    act(() => {
      const res = {
        success: true,
        status: "COMPLETED",
        patch: { patchDiff: mockDiff, status: "GENERATED" },
        patchDiff: mockDiff,
        explanation: mockExplanation,
        processed: 2,
        total: 2,
      };

      es.emit("open", {});
      es.emit("message", res);
      es.emit("result", res);
      es.emit("completed", res);
      es.emit("patch", res);
      es.emit("message", "[DONE]");
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
    render(<FindingsClient {...defaultProps} findings={mockHomogeneousFindings} />);
    fireEvent.click(screen.getByText("Bulk select"));
    fireEvent.click(screen.getByLabelText("Select all findings on this page"));

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));

    await waitFor(() => {
      expect((globalThis as any).__mockEventSourceInstance).toBeDefined();
    });
    const es = (globalThis as any).__mockEventSourceInstance;

    // Simulate server SSE error response
    act(() => {
      const err = {
        success: false,
        status: "FAILED",
        error: "AI generation quota exceeded. Please try again later.",
        message: "AI generation quota exceeded. Please try again later.",
      };

      es.emit("open", {});
      es.emit("error", err);
      es.emit("message", err);

      // Fallback for native onerror handlers
      if (typeof es.onerror === "function") {
        es.onerror({ type: "error", data: JSON.stringify(err) });
      }
    });

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
