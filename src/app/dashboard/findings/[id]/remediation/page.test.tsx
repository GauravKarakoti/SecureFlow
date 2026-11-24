/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "finding-7" }),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@/components/findings/patch-diff-viewer", () => ({
  PatchDiffViewer: ({ patchDiff, explanation }: { patchDiff: string; explanation: string }) => (
    <div data-testid="patch-diff-viewer">
      <pre>{patchDiff}</pre>
      <p>{explanation}</p>
    </div>
  ),
}));

import RemediationPage from "./page";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const patchBody = {
  patch: { patchDiff: "- bad()\n+ good()" },
  explanation: "Replaced the unsafe call.",
};

describe("RemediationPage client component (#1372)", () => {
  const originalFetch = global.fetch;
  const originalConfirm = window.confirm;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    window.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.confirm = originalConfirm;
  });

  async function generatePatch() {
    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));
    await screen.findByTestId("patch-diff-viewer");
  }

  it("shows the idle prompt and generate button before any patch exists", () => {
    render(<RemediationPage />);

    expect(screen.getByRole("heading", { name: "AI Remediation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Remediation Patch/ })).toBeEnabled();
    expect(screen.queryByTestId("patch-diff-viewer")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables the button and shows the analyzing state while the patch is generated", async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (resolveFetch = resolve)));
    render(<RemediationPage />);

    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));

    const busy = await screen.findByRole("button", { name: /Analyzing/ });
    expect(busy).toBeDisabled();

    resolveFetch(jsonResponse(patchBody));
    await screen.findByTestId("patch-diff-viewer");
  });

  it("requests a patch for the finding in the route and renders the returned diff", async () => {
    fetchMock.mockResolvedValue(jsonResponse(patchBody));
    render(<RemediationPage />);

    await generatePatch();

    expect(fetchMock).toHaveBeenCalledWith("/api/findings/finding-7/remediate", { method: "POST" });
    expect(screen.getByTestId("patch-diff-viewer")).toHaveTextContent("+ good()");
    expect(screen.getByTestId("patch-diff-viewer")).toHaveTextContent("Replaced the unsafe call.");
    expect(toastSuccess).toHaveBeenCalledWith("Remediation patch generated successfully");
    expect(screen.getByRole("button", { name: /Approve & create draft PR/ })).toBeEnabled();
  });

  it("reports a toast error and stays on the idle view when generation fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    render(<RemediationPage />);

    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to generate remediation patch"),
    );
    expect(screen.queryByTestId("patch-diff-viewer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Remediation Patch/ })).toBeEnabled();
  });

  it("does not call the apply endpoint when the user declines the confirmation", async () => {
    fetchMock.mockResolvedValue(jsonResponse(patchBody));
    window.confirm = vi.fn(() => false);
    render(<RemediationPage />);
    await generatePatch();

    fireEvent.click(screen.getByRole("button", { name: /Approve & create draft PR/ }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("applies the approved patch and links to the draft pull request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(patchBody))
      .mockResolvedValueOnce(
        jsonResponse({ pullRequest: "https://github.com/acme/widgets/pull/9" }),
      );
    render(<RemediationPage />);
    await generatePatch();

    fireEvent.click(screen.getByRole("button", { name: /Approve & create draft PR/ }));

    const link = await screen.findByRole("link", { name: /Open draft pull request/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/9");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/findings/finding-7/remediate/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(toastSuccess).toHaveBeenLastCalledWith(
      "Approved fix committed and draft pull request opened",
    );
    expect(
      screen.queryByRole("button", { name: /Approve & create draft PR/ }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the server error message and keeps the approve button when applying fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(patchBody))
      .mockResolvedValueOnce(jsonResponse({ error: "GitHub token expired" }, false));
    render(<RemediationPage />);
    await generatePatch();

    fireEvent.click(screen.getByRole("button", { name: /Approve & create draft PR/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("GitHub token expired"));
    expect(screen.getByRole("button", { name: /Approve & create draft PR/ })).toBeEnabled();
    expect(screen.queryByRole("link", { name: /Open draft pull request/ })).not.toBeInTheDocument();
  });

  it("falls back to a generic message when the apply failure has no error text", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(patchBody))
      .mockResolvedValueOnce(jsonResponse({}, false));
    render(<RemediationPage />);
    await generatePatch();

    fireEvent.click(screen.getByRole("button", { name: /Approve & create draft PR/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to create pull request"));
  });

  it("displays Verified Ready Fix badge when patch is verified", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...patchBody,
        verified: true,
      }),
    );
    render(<RemediationPage />);
    await generatePatch();

    expect(screen.getByText("✅ Verified Ready Fix")).toBeInTheDocument();
  });

  it("never displays failing patches as ready fixes and surfaces short note", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        verified: false,
        readyFix: false,
        note: "AI patch failed verification and was discarded.",
        patch: { patchDiff: "" },
      }),
    );
    render(<RemediationPage />);
    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));

    await screen.findByRole("alert");
    expect(
      screen.getByText("AI patch failed verification and was discarded."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("patch-diff-viewer")).not.toBeInTheDocument();
    expect(screen.queryByText("✅ Verified Ready Fix")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Approve & create draft PR/ }),
    ).not.toBeInTheDocument();
  });
});
