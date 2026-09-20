/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import BulkRemediationBar from "./bulk-remediation-bar";
import type { FindingRow } from "@/lib/actions/findings";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), toasts: [], dismiss: vi.fn() }),
}));

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

function patchResponse(patchDiff: string) {
  return new Response(
    JSON.stringify({
      success: true,
      patch: { patchDiff, status: "GENERATED" },
      explanation: "explanation",
    }),
    { status: 200 },
  );
}

const first = [finding("f-1", "src/a.ts"), finding("f-2", "src/b.ts")];
const second = [finding("f-3", "src/c.ts")];

describe("BulkRemediationBar", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not keep showing a patch generated for a different selection", async () => {
    fetchMock.mockResolvedValue(patchResponse("+++ b/src/a.ts"));
    const { rerender } = render(<BulkRemediationBar selectedFindings={first} />);

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));
    await screen.findByTestId("bulk-patch-review");

    rerender(<BulkRemediationBar selectedFindings={second} />);

    expect(screen.queryByTestId("bulk-patch-review")).not.toBeInTheDocument();
    expect(screen.queryByText("+++ b/src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByTestId("generate-bulk-patch-button")).toBeInTheDocument();
  });

  it("does not show a patch that arrives after the selection changed", async () => {
    let resolve!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const { rerender } = render(<BulkRemediationBar selectedFindings={first} />);

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));
    rerender(<BulkRemediationBar selectedFindings={second} />);
    resolve(patchResponse("+++ b/src/a.ts"));

    await waitFor(() => {
      expect(screen.getByTestId("generate-bulk-patch-button")).not.toBeDisabled();
    });
    expect(screen.queryByTestId("bulk-patch-review")).not.toBeInTheDocument();
  });

  it("keeps the patch while the selection is unchanged", async () => {
    fetchMock.mockResolvedValue(patchResponse("+++ b/src/a.ts"));
    const { rerender } = render(<BulkRemediationBar selectedFindings={first} />);

    fireEvent.click(screen.getByTestId("generate-bulk-patch-button"));
    await screen.findByTestId("bulk-patch-review");

    // A new array with the same findings, as the parent's useMemo produces.
    rerender(<BulkRemediationBar selectedFindings={[...first]} />);

    expect(screen.getByTestId("bulk-patch-review")).toBeInTheDocument();
  });
});
