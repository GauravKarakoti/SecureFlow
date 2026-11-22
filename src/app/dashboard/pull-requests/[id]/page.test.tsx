/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { authMock, pullRequestFindFirstMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  pullRequestFindFirstMock: vi.fn(),
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
    pullRequest: { findFirst: pullRequestFindFirstMock },
  },
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock, notFound: notFoundMock }));

import PullRequestDetailPage from "./page";

describe("PullRequestDetailPage (/dashboard/pull-requests/[id]) (#1923)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to signin", async () => {
    authMock.mockResolvedValueOnce(null);

    await expect(
      PullRequestDetailPage({ params: Promise.resolve({ id: "pr-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT: /api/auth/signin");
  });

  it("triggers notFound when PR does not exist or user lacks access", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    pullRequestFindFirstMock.mockResolvedValueOnce(null);

    await expect(
      PullRequestDetailPage({ params: Promise.resolve({ id: "pr-missing" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(pullRequestFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "pr-missing",
          repository: { userId: "user-123" },
        },
      }),
    );
  });

  it("renders PR details and scan comparison view when PR is found", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "user-123" } });
    pullRequestFindFirstMock.mockResolvedValueOnce({
      id: "pr-1",
      prNumber: 42,
      title: "Fix critical auth token leak",
      status: "PASS",
      createdAt: new Date("2026-11-20T10:00:00Z"),
      authorLogin: "alice",
      repository: {
        id: "repo-1",
        fullName: "acme/api",
        userId: "user-123",
      },
      scans: [
        {
          id: "scan-2",
          headSha: "sha2222222",
          createdAt: new Date("2026-11-21T10:00:00Z"),
          riskScore: 0,
          policyDecision: "PASS",
          findings: [],
        },
        {
          id: "scan-1",
          headSha: "sha1111111",
          createdAt: new Date("2026-11-20T10:00:00Z"),
          riskScore: 25,
          policyDecision: "BLOCK",
          findings: [
            {
              id: "f-1",
              fingerprint: "fp-1",
              type: "Secret",
              severity: "CRITICAL",
              fileLocation: "src/auth.ts",
            },
          ],
        },
      ],
    });

    const jsx = await PullRequestDetailPage({ params: Promise.resolve({ id: "pr-1" }) });
    render(jsx);

    expect(screen.getByText("Fix critical auth token leak")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByTestId("scan-comparison-view")).toBeInTheDocument();
  });
});
