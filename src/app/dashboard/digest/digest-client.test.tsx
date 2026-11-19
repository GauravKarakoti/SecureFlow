/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DigestClient, { type SerializedDigest } from "./digest-client";

const { requestManualDigestGenerationMock, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  requestManualDigestGenerationMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/actions/digest", () => ({
  requestManualDigestGeneration: requestManualDigestGenerationMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.mock("@/components/time-ago", () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

describe("DigestClient component (#1788)", () => {
  const sampleDigests: SerializedDigest[] = [
    {
      id: "digest-1",
      startDate: "2026-11-03T00:00:00.000Z",
      endDate: "2026-11-10T00:00:00.000Z",
      newFindingsCount: 12,
      dismissedFindingsCount: 3,
      resolvedFindingsCount: 7,
      blockedPrsCount: 2,
      topRepositories: [
        {
          repositoryId: "repo-1",
          fullName: "acme/backend",
          name: "backend",
          openFindingsCount: 10,
          criticalCount: 3,
        },
      ],
      topFindingTypes: [
        {
          type: "SQL_INJECTION",
          count: 5,
          severity: "CRITICAL",
        },
      ],
      sentAt: "2026-11-10T01:00:00.000Z",
      createdAt: "2026-11-10T01:00:00.000Z",
    },
    {
      id: "digest-2",
      startDate: "2026-10-27T00:00:00.000Z",
      endDate: "2026-11-03T00:00:00.000Z",
      newFindingsCount: 5,
      dismissedFindingsCount: 1,
      resolvedFindingsCount: 4,
      blockedPrsCount: 0,
      topRepositories: [],
      topFindingTypes: [],
      sentAt: null,
      createdAt: "2026-11-03T01:00:00.000Z",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when there are no digests", () => {
    render(
      <DigestClient
        initialDigests={[]}
        weeklyDigestEnabled={true}
        userEmail="dev@secureflow.test"
        userName="Operator"
      />,
    );

    expect(screen.getByText("No Security Digests Yet")).toBeDefined();
    expect(screen.getByRole("button", { name: /Generate Your First Digest/i })).toBeDefined();
  });

  it("renders opt-out warning banner when weekly digests are disabled", () => {
    render(
      <DigestClient
        initialDigests={sampleDigests}
        weeklyDigestEnabled={false}
        userEmail="dev@secureflow.test"
        userName="Operator"
      />,
    );

    expect(screen.getByText("Weekly email digest is turned off.")).toBeDefined();
  });

  it("renders metrics, top repositories, top types, and archive table for active digest", () => {
    render(
      <DigestClient
        initialDigests={sampleDigests}
        weeklyDigestEnabled={true}
        userEmail="dev@secureflow.test"
        userName="Operator"
      />,
    );

    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(1); // newFindingsCount
    expect(screen.getAllByText("7").length).toBeGreaterThanOrEqual(1); // resolvedFindingsCount
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1); // dismissedFindingsCount
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1); // blockedPrsCount
    expect(screen.getByText("acme/backend")).toBeDefined();
    expect(screen.getByText("3 CRITICAL")).toBeDefined();
    expect(screen.getByText("SQL_INJECTION")).toBeDefined();
    expect(screen.getByText("Digest Archive")).toBeDefined();
  });

  it("switches active digest when clicking View in archive table", () => {
    render(
      <DigestClient
        initialDigests={sampleDigests}
        weeklyDigestEnabled={true}
        userEmail="dev@secureflow.test"
        userName="Operator"
      />,
    );

    // Initial selected digest is digest-1, which has "Viewing" button. The other one has "View".
    const viewButton = screen.getByRole("button", { name: "View" });
    fireEvent.click(viewButton);

    // After clicking, second digest is now active and has 5 new findings and 4 resolved findings
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("4").length).toBeGreaterThanOrEqual(1);
  });

  it("triggers manual digest generation when button clicked", async () => {
    requestManualDigestGenerationMock.mockResolvedValueOnce({
      success: true,
      message: "Weekly digest generated successfully!",
      digest: {
        id: "digest-new",
        startDate: "2026-11-10T00:00:00.000Z",
        endDate: "2026-11-17T00:00:00.000Z",
        newFindingsCount: 1,
        dismissedFindingsCount: 0,
        resolvedFindingsCount: 2,
        blockedPrsCount: 0,
        topRepositories: [],
        topFindingTypes: [],
        sentAt: null,
        createdAt: "2026-11-17T00:00:00.000Z",
      },
    });

    render(
      <DigestClient
        initialDigests={sampleDigests}
        weeklyDigestEnabled={true}
        userEmail="dev@secureflow.test"
        userName="Operator"
      />,
    );

    const genBtn = screen.getByRole("button", { name: /Generate Digest Now/i });
    fireEvent.click(genBtn);

    await waitFor(() => {
      expect(requestManualDigestGenerationMock).toHaveBeenCalled();
      expect(toastSuccessMock).toHaveBeenCalledWith("Weekly digest generated successfully!");
    });
  });
});
