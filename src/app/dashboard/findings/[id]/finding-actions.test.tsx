/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import FindingActions from "./finding-actions";

const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();
const toastMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    refresh: routerRefreshMock,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: toastMock,
  }),
}));

describe("FindingActions client component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders with initial finding severity, triage status, and note", () => {
    render(
      <FindingActions
        findingId="finding-1"
        initialSeverity="HIGH"
        initialTriageStatus="OPEN"
        initialNote="Needs triage"
      />,
    );

    expect(screen.getByText("Triage & Management")).toBeInTheDocument();
    expect(screen.getAllByText("Open").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue("Needs triage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete Finding/i })).toBeEnabled();
  });

  it("enables Save Changes button when note is modified", () => {
    render(
      <FindingActions
        findingId="finding-1"
        initialSeverity="HIGH"
        initialTriageStatus="OPEN"
        initialNote=""
      />,
    );

    const textarea = screen.getByPlaceholderText(/Document reason/i);
    fireEvent.change(textarea, { target: { value: "Identified as false positive" } });

    const saveBtn = screen.getByRole("button", { name: "Save Changes" });
    expect(saveBtn).toBeEnabled();
  });

  it("sends PATCH request to /api/findings/[id] on save and triggers refresh", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "finding-1", status: "success" }),
    });

    render(
      <FindingActions
        findingId="finding-1"
        initialSeverity="HIGH"
        initialTriageStatus="OPEN"
        initialNote=""
      />,
    );

    const textarea = screen.getByPlaceholderText(/Document reason/i);
    fireEvent.change(textarea, { target: { value: "Verified risk mitigated" } });

    const saveBtn = screen.getByRole("button", { name: "Save Changes" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/findings/finding-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Verified risk mitigated" }),
      });
    });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "success",
          title: "Finding updated",
        }),
      );
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it("handles PATCH failure and surfaces error toast", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: "Invalid triage payload" }),
    });

    render(
      <FindingActions
        findingId="finding-1"
        initialSeverity="HIGH"
        initialTriageStatus="OPEN"
        initialNote=""
      />,
    );

    const textarea = screen.getByPlaceholderText(/Document reason/i);
    fireEvent.change(textarea, { target: { value: "Faulty payload" } });

    const saveBtn = screen.getByRole("button", { name: "Save Changes" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Update failed",
          description: "Invalid triage payload",
        }),
      );
    });
  });

  it("sends DELETE request to /api/findings/[id] on confirmation and redirects to /dashboard/findings", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 204,
    });

    render(
      <FindingActions
        findingId="finding-1"
        initialSeverity="HIGH"
        initialTriageStatus="OPEN"
        initialNote=""
      />,
    );

    // Click delete finding trigger button
    const deleteTrigger = screen.getByRole("button", { name: /Delete Finding/i });
    fireEvent.click(deleteTrigger);

    // Confirm in dialog
    const confirmBtn = screen.getByRole("button", { name: /Confirm Delete/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/findings/finding-1", {
        method: "DELETE",
      });
    });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "success",
          title: "Finding deleted",
        }),
      );
      expect(routerPushMock).toHaveBeenCalledWith("/dashboard/findings");
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it("handles DELETE failure gracefully", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: "Finding not found" }),
    });

    render(
      <FindingActions
        findingId="finding-1"
        initialSeverity="HIGH"
        initialTriageStatus="OPEN"
        initialNote=""
      />,
    );

    const deleteTrigger = screen.getByRole("button", { name: /Delete Finding/i });
    fireEvent.click(deleteTrigger);

    const confirmBtn = screen.getByRole("button", { name: /Confirm Delete/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Deletion failed",
          description: "Finding not found",
        }),
      );
    });
    expect(routerPushMock).not.toHaveBeenCalled();
  });
});
