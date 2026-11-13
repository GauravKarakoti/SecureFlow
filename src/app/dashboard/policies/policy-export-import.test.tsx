/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PolicyExportImport } from "./policy-export-import";
import * as sonner from "sonner";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("PolicyExportImport Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    window.URL.createObjectURL = vi.fn(() => "mock-url");
    window.URL.revokeObjectURL = vi.fn();
  });

  it("renders Export and Import buttons", () => {
    render(<PolicyExportImport />);
    expect(screen.getByTestId("export-policies-button")).toBeInTheDocument();
    expect(screen.getByTestId("import-policies-button")).toBeInTheDocument();
  });

  it("handles export download flow", async () => {
    const mockBlob = new Blob(["{}"], { type: "application/json" });
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      blob: async () => mockBlob,
    });

    render(<PolicyExportImport />);
    const exportBtn = screen.getByTestId("export-policies-button");
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/policies/export");
      expect(sonner.toast.success).toHaveBeenCalledWith("Policies exported successfully");
    });
  });

  it("rejects files larger than 1 MB before fetching preview", async () => {
    render(<PolicyExportImport />);
    const fileInput = screen.getByTestId("policy-file-input");

    const largeFile = new File(["a".repeat(1024 * 1024 + 10)], "policies.json", {
      type: "application/json",
    });

    fireEvent.change(fileInput, { target: { files: [largeFile] } });

    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalledWith(
        "Policy file exceeds maximum allowed size (1 MB)",
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  it("fetches preview on valid file upload and displays import dialog", async () => {
    const previewData = {
      valid: true,
      totalInFile: 2,
      toCreate: 1,
      toUpdate: 1,
      unchanged: 0,
      items: [
        {
          name: "Policy 1",
          description: "Desc 1",
          severity: "HIGH",
          enabled: true,
          action: "BLOCK",
          status: "update",
        },
        {
          name: "Policy 2",
          description: "Desc 2",
          severity: "LOW",
          enabled: false,
          action: "AUDIT",
          status: "create",
        },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => previewData,
    });

    render(<PolicyExportImport />);
    const fileInput = screen.getByTestId("policy-file-input");

    const validFile = new File(
      [JSON.stringify({ version: "1.0", policies: [] })],
      "policies.json",
      {
        type: "application/json",
      },
    );

    fireEvent.change(fileInput, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/policies/import/preview", expect.any(Object));
      expect(screen.getByText("Preview Policy Import")).toBeInTheDocument();
      expect(screen.getByText("Policy 1")).toBeInTheDocument();
      expect(screen.getByText("Policy 2")).toBeInTheDocument();
    });
  });

  it("submits import when user confirms in dialog", async () => {
    const previewData = {
      valid: true,
      totalInFile: 1,
      toCreate: 1,
      toUpdate: 0,
      unchanged: 0,
      items: [
        {
          name: "Policy 1",
          description: "Desc 1",
          severity: "HIGH",
          enabled: true,
          action: "BLOCK",
          status: "create",
        },
      ],
    };

    // 1st fetch: Preview
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => previewData,
    });

    // 2nd fetch: Import apply
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, total: 1, createdCount: 1, updatedCount: 0 }),
    });

    render(<PolicyExportImport />);
    const fileInput = screen.getByTestId("policy-file-input");

    const validFile = new File(
      [JSON.stringify({ version: "1.0", policies: [] })],
      "policies.json",
      {
        type: "application/json",
      },
    );

    fireEvent.change(fileInput, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByText("Preview Policy Import")).toBeInTheDocument();
    });

    const applyBtn = screen.getByTestId("confirm-apply-import-button");
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/policies/import", expect.any(Object));
      expect(sonner.toast.success).toHaveBeenCalledWith(
        "Successfully applied 1 policies (1 created, 0 updated)",
      );
    });
  });
});
