/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import ApiTokensCard from "./api-tokens-card";
import type { ApiTokenItem } from "@/lib/actions/settings";

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

const mockCreateApiToken = vi.fn();
const mockRevokeApiToken = vi.fn();

vi.mock("@/lib/actions/settings", () => ({
  createApiToken: (...args: any[]) => mockCreateApiToken(...args),
  revokeApiToken: (...args: any[]) => mockRevokeApiToken(...args),
}));

describe("ApiTokensCard component (#1867)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleTokens: ApiTokenItem[] = [
    {
      id: "tok-1",
      name: "GitHub Actions CI",
      tokenPrefix: "sft_12345678",
      scopes: ["scans:write", "findings:read"],
      expiresAt: new Date(Date.now() + 864000000).toISOString(),
      revokedAt: null,
      lastUsedAt: new Date().toISOString(),
      lastUsedIp: "203.0.113.195",
      createdAt: new Date().toISOString(),
    },
    {
      id: "tok-2",
      name: "Old Revoked Key",
      tokenPrefix: "sft_abcdef99",
      scopes: ["findings:read"],
      expiresAt: null,
      revokedAt: new Date().toISOString(),
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: new Date().toISOString(),
    },
  ];

  it("renders empty state when no tokens exist", () => {
    render(<ApiTokensCard initialTokens={[]} />);
    expect(screen.getByText("Personal API Tokens")).toBeInTheDocument();
    expect(screen.getByText("No personal API tokens yet")).toBeInTheDocument();
  });

  it("renders token list with prefixes, status, and scopes", () => {
    render(<ApiTokensCard initialTokens={sampleTokens} />);
    expect(screen.getByText("GitHub Actions CI")).toBeInTheDocument();
    expect(screen.getByText("sft_12345678...")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText("scans:write")).toBeInTheDocument();
    expect(screen.getByText(/from 203.0.113.195/)).toBeInTheDocument();
  });

  it("opens modal and creates a new token successfully", async () => {
    mockCreateApiToken.mockResolvedValueOnce({
      success: true,
      token: "sft_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      tokenItem: {
        id: "tok-new",
        name: "New Automation",
        tokenPrefix: "sft_00112233",
        scopes: ["scans:write", "findings:read"],
        expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdAt: new Date().toISOString(),
      },
    });

    render(<ApiTokensCard initialTokens={[]} />);

    fireEvent.click(screen.getByText("Generate New Token"));
    expect(screen.getByText("Generate Personal API Token")).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("e.g. GitHub Actions CI or CLI Laptop");
    fireEvent.change(nameInput, { target: { value: "New Automation" } });

    fireEvent.click(screen.getByText("Create Token"));

    await waitFor(() => {
      expect(mockCreateApiToken).toHaveBeenCalledWith({
        name: "New Automation",
        scopes: expect.arrayContaining(["scans:write", "findings:read"]),
        expiresInDays: 30,
        customExpiresAt: null,
      });
    });

    // Check one-time token banner display
    await waitFor(() => {
      expect(screen.getByText("Save your new token")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("sft_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"),
      ).toBeInTheDocument();
    });
  });

  it("handles revoking an active token", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    mockRevokeApiToken.mockResolvedValueOnce({ success: true });

    render(<ApiTokensCard initialTokens={sampleTokens} />);

    const revokeButtons = screen.getAllByRole("button", { name: /Revoke/i });
    fireEvent.click(revokeButtons[0]);

    await waitFor(() => {
      expect(mockRevokeApiToken).toHaveBeenCalledWith("tok-1");
      expect(toastSuccessMock).toHaveBeenCalledWith(
        expect.stringContaining('Token "GitHub Actions CI" revoked successfully.'),
      );
    });
  });
});
