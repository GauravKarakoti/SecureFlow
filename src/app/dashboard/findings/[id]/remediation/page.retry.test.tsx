/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

const rateLimitBody = {
  success: false,
  error: "The AI provider rate limit was reached. Please retry in a minute.",
  code: "AI_RATE_LIMITED",
  retryable: true,
};

describe("RemediationPage retry after an AI rate limit (#1513)", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows a clear message and a Retry button when the AI is rate limited", async () => {
    fetchMock.mockResolvedValue(jsonResponse(rateLimitBody, false));
    render(<RemediationPage />);

    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("rate limit was reached");
    expect(screen.getByRole("button", { name: /Retry/ })).toBeEnabled();
    expect(toastError).toHaveBeenCalledWith(rateLimitBody.error);
    expect(screen.queryByTestId("patch-diff-viewer")).not.toBeInTheDocument();
  });

  it("retries the request and shows the patch once the provider recovers", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rateLimitBody, false))
      .mockResolvedValueOnce(jsonResponse(patchBody));
    render(<RemediationPage />);

    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await screen.findByTestId("patch-diff-viewer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("patch-diff-viewer")).toHaveTextContent("+ good()");
  });

  it("keeps the generic error and no Retry banner for a non-retryable failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    render(<RemediationPage />);

    fireEvent.click(screen.getByRole("button", { name: /Generate Remediation Patch/ }));

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to generate remediation patch"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Remediation Patch/ })).toBeEnabled();
  });
});
