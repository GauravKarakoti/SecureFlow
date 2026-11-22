/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { authMock, scanResultFindFirstMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  scanResultFindFirstMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  default: {
    scanResult: { findFirst: scanResultFindFirstMock },
  },
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock, notFound: notFoundMock }));

import ScanDetailPage from "./page";

describe("ScanDetailPage (/dashboard/scans/[id]) (#1923)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to signin", async () => {
    authMock.mockResolvedValueOnce(null);

    await expect(
      ScanDetailPage({ params: Promise.resolve({ id: "scan-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT: /api/auth/signin");
  });

  it("triggers notFound when scan does not exist or user lacks access", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    scanResultFindFirstMock.mockResolvedValueOnce(null);

    await expect(
      ScanDetailPage({ params: Promise.resolve({ id: "scan-missing" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(scanResultFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "scan-missing",
          pullRequest: { repository: { userId: "user-123" } },
        },
      }),
    );
  });

  it("renders scan details and comparison view when scan is found", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    scanResultFindFirstMock.mockResolvedValueOnce({
      id: "scan-2",
      headSha: "sha2222222",
      createdAt: new Date("2026-11-21T10:00:00Z"),
      riskScore: 10,
      policyDecision: "PASS",
      findings: [
        {
          id: "f-1",
          type: "Vulnerability",
          severity: "HIGH",
          fileLocation: "src/server.ts",
          lineStart: 10,
        },
      ],
      pullRequest: {
        id: "pr-1",
        prNumber: 99,
        title: "Update API endpoint",
        repository: { id: "repo-1", fullName: "acme/api", userId: "user-123" },
        scans: [
          {
            id: "scan-2",
            headSha: "sha2222222",
            createdAt: new Date("2026-11-21T10:00:00Z"),
            findings: [],
          },
          {
            id: "scan-1",
            headSha: "sha1111111",
            createdAt: new Date("2026-11-20T10:00:00Z"),
            findings: [],
          },
        ],
      },
    });

    const jsx = await ScanDetailPage({ params: Promise.resolve({ id: "scan-2" }) });
    render(jsx);

    expect(screen.getByText(/Scan for commit sha2222/i)).toBeInTheDocument();
    expect(screen.getByText(/PR #99/i)).toBeInTheDocument();
    expect(screen.getAllByText("src/server.ts:10").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("scan-comparison-view")).toBeInTheDocument();
  });
});
