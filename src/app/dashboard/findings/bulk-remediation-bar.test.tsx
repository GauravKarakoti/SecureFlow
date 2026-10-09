/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import BulkRemediationBar from "./bulk-remediation-bar";
import type { FindingRow } from "@/lib/actions/findings";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), toasts: [], dismiss: vi.fn() }),
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

function finding(id: string, fileLocation: string): FindingRow {
  return {
    id,
    type: "SECRET",
    severity: "HIGH",
    fileLocation,
    lineStart: 1,
    lineEnd: 1,
    codeSnippet: null,
    explanation: null,
    remediation: null,
    promptInjectionSuspected: false,
    fingerprint: `fp-${id}`,
    createdAt: new Date(0),
    repositoryId: "repo-1",
    repositoryFullName: "owner/repo",
    pullRequestNumber: 1,
    triageStatus: "OPEN",
    triageNote: null,
  } as FindingRow;
}

const first = [finding("f-1", "src/a.ts"), finding("f-2", "src/b.ts")];
const second = [finding("f-3", "src/c.ts")];

describe("BulkRemediationBar", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as any).__mockEventSourceInstance;
  });

  it("does not keep showing a patch generated for a different selection", async () => {
    const { rerender } = render(<BulkRemediationBar selectedFindings={first} />);

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));

    await waitFor(() => {
      expect((globalThis as any).__mockEventSourceInstance).toBeDefined();
    });
    const es = (globalThis as any).__mockEventSourceInstance;

    act(() => {
      const res = {
        success: true,
        status: "GENERATED",
        patch: { patchDiff: "+++ b/src/a.ts", status: "GENERATED" },
        patchDiff: "+++ b/src/a.ts",
        explanation: "explanation",
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

    await screen.findByTestId("bulk-patch-review");

    rerender(<BulkRemediationBar selectedFindings={second} />);

    expect(screen.queryByTestId("bulk-patch-review")).not.toBeInTheDocument();
    expect(screen.queryByText("+++ b/src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByTestId("generate-bulk-patch-button")).toBeInTheDocument();
  });

  it("does not show a patch that arrives after the selection changed", async () => {
    const { rerender } = render(<BulkRemediationBar selectedFindings={first} />);

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));

    await waitFor(() => {
      expect((globalThis as any).__mockEventSourceInstance).toBeDefined();
    });
    const es = (globalThis as any).__mockEventSourceInstance;

    rerender(<BulkRemediationBar selectedFindings={second} />);

    // Arrives after selection changed
    act(() => {
      const res = {
        success: true,
        status: "GENERATED",
        patch: { patchDiff: "+++ b/src/a.ts", status: "GENERATED" },
        patchDiff: "+++ b/src/a.ts",
        explanation: "explanation",
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

    await waitFor(() => {
      expect(screen.getByTestId("generate-bulk-patch-button")).not.toBeDisabled();
    });
    expect(screen.queryByTestId("bulk-patch-review")).not.toBeInTheDocument();
  });

  it("keeps the patch while the selection is unchanged", async () => {
    const { rerender } = render(<BulkRemediationBar selectedFindings={first} />);

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));

    await waitFor(() => {
      expect((globalThis as any).__mockEventSourceInstance).toBeDefined();
    });
    const es = (globalThis as any).__mockEventSourceInstance;

    act(() => {
      const res = {
        success: true,
        status: "GENERATED",
        patch: { patchDiff: "+++ b/src/a.ts", status: "GENERATED" },
        patchDiff: "+++ b/src/a.ts",
        explanation: "explanation",
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

    await screen.findByTestId("bulk-patch-review");

    // A new array with the same findings, as the parent's useMemo produces.
    rerender(<BulkRemediationBar selectedFindings={[...first]} />);

    expect(screen.getByTestId("bulk-patch-review")).toBeInTheDocument();
  });
});
