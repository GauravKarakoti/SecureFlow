/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RepositoryScanTrendChart } from "./repository-scan-trend-chart";
import type { RepositoryScanTrendResponse } from "@/lib/repositories/scan-trend";

const mockRepositories = [
  { id: "repo-alpha", fullName: "acme/alpha-service" },
  { id: "repo-beta", fullName: "acme/beta-worker" },
];

const mockTwoScansData: RepositoryScanTrendResponse = {
  repositoryId: "repo-alpha",
  repositoryName: "acme/alpha-service",
  rangeDays: 30,
  totalScans: 2,
  scans: [
    {
      id: "scan-1",
      createdAt: "2026-11-01T10:00:00Z",
      date: "2026-11-01",
      prNumber: 42,
      prTitle: "Upgrade dependencies",
      riskScore: 75,
      policyDecision: "BLOCK",
      critical: 2,
      high: 3,
      medium: 1,
      low: 0,
      info: 0,
      total: 6,
    },
    {
      id: "scan-2",
      createdAt: "2026-11-15T12:00:00Z",
      date: "2026-11-15",
      prNumber: 45,
      prTitle: "Fix critical CVEs",
      riskScore: 25,
      policyDecision: "PASS",
      critical: 0,
      high: 1,
      medium: 1,
      low: 0,
      info: 0,
      total: 2,
    },
  ],
};

const mockSingleScanData: RepositoryScanTrendResponse = {
  repositoryId: "repo-alpha",
  repositoryName: "acme/alpha-service",
  rangeDays: 30,
  totalScans: 1,
  scans: [
    {
      id: "scan-1",
      createdAt: "2026-11-10T10:00:00Z",
      date: "2026-11-10",
      prNumber: 10,
      prTitle: "Initial scan",
      riskScore: 50,
      policyDecision: "REVIEW",
      critical: 1,
      high: 0,
      medium: 2,
      low: 1,
      info: 0,
      total: 4,
    },
  ],
};

const mockZeroScansData: RepositoryScanTrendResponse = {
  repositoryId: "repo-alpha",
  repositoryName: "acme/alpha-service",
  rangeDays: 30,
  totalScans: 0,
  scans: [],
};

describe("RepositoryScanTrendChart Component", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders loading state initially while fetching", async () => {
    let resolveFetch: (val: any) => void;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(<RepositoryScanTrendChart repositoryId="repo-alpha" repositories={mockRepositories} />);

    expect(screen.getByTestId("trend-loading-state")).toBeDefined();
    expect(screen.getByText("Loading scan severity trend...")).toBeDefined();

    // Clean up promise
    resolveFetch!({
      ok: true,
      json: async () => mockTwoScansData,
    });
  });

  it("handles error state and retries on button click", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal database timeout" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTwoScansData,
      });

    render(<RepositoryScanTrendChart repositoryId="repo-alpha" repositories={mockRepositories} />);

    await waitFor(() => {
      expect(screen.getByTestId("trend-error-state")).toBeDefined();
    });

    expect(screen.getByText("Internal database timeout")).toBeDefined();
    const retryBtn = screen.getByTestId("trend-retry-button");
    expect(retryBtn).toBeDefined();

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("trend-error-state")).toBeNull();
      expect(screen.getByText("Safer Over Time")).toBeDefined();
    });
  });

  it("renders empty state for repository with fewer than two scans (0 scans)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockZeroScansData,
    });

    render(<RepositoryScanTrendChart repositoryId="repo-alpha" repositories={mockRepositories} />);

    await waitFor(() => {
      expect(screen.getByTestId("insufficient-scans-empty-state")).toBeDefined();
    });

    expect(screen.getByText("Insufficient Scan History")).toBeDefined();
    expect(
      screen.getByText(/At least two scans are required to plot security trends/),
    ).toBeDefined();
    expect(screen.getByText("0 scans recorded")).toBeDefined();
  });

  it("renders empty state for repository with exactly one scan", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSingleScanData,
    });

    render(<RepositoryScanTrendChart repositoryId="repo-alpha" repositories={mockRepositories} />);

    await waitFor(() => {
      expect(screen.getByTestId("insufficient-scans-empty-state")).toBeDefined();
    });

    expect(screen.getByText("Insufficient Scan History")).toBeDefined();
    expect(screen.getByText(/1 scan recorded \(PR #10 with 4 findings\)/)).toBeDefined();
  });

  it("renders chart and safer trend posture when >= 2 scans show improving findings", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTwoScansData,
    });

    render(<RepositoryScanTrendChart repositoryId="repo-alpha" repositories={mockRepositories} />);

    await waitFor(() => {
      expect(screen.queryByTestId("insufficient-scans-empty-state")).toBeNull();
      expect(screen.getByText("Safer Over Time")).toBeDefined();
    });

    expect(screen.getByText(/Findings decreased from 6 to 2 \(-4\)/)).toBeDefined();
  });

  it("updates range and refetches when range selector buttons (7d/30d/90d) are clicked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTwoScansData,
    });
    global.fetch = fetchMock;

    render(
      <RepositoryScanTrendChart
        repositoryId="repo-alpha"
        repositories={mockRepositories}
        defaultRange={30}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/repositories/repo-alpha/scans?days=30");
    });

    // Click 7d button
    const btn7d = screen.getByTestId("range-7");
    fireEvent.click(btn7d);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/repositories/repo-alpha/scans?days=7");
    });

    // Click 90d button
    const btn90d = screen.getByTestId("range-90");
    fireEvent.click(btn90d);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/repositories/repo-alpha/scans?days=90");
    });
  });

  it("toggles between line chart and stacked bar chart", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTwoScansData,
    });

    render(
      <RepositoryScanTrendChart
        repositoryId="repo-alpha"
        repositories={mockRepositories}
        initialChartType="line"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chart-type-line")).toBeDefined();
    });

    const lineBtn = screen.getByTestId("chart-type-line");
    const barBtn = screen.getByTestId("chart-type-bar");

    expect(lineBtn.getAttribute("aria-pressed")).toBe("true");
    expect(barBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(barBtn);

    expect(lineBtn.getAttribute("aria-pressed")).toBe("false");
    expect(barBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches repository when selecting another repo in dropdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockTwoScansData,
    });
    global.fetch = fetchMock;

    render(<RepositoryScanTrendChart repositoryId="repo-alpha" repositories={mockRepositories} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/repositories/repo-alpha/scans?days=30");
    });

    const repoSelect = screen.getByRole("combobox");
    fireEvent.change(repoSelect, { target: { value: "repo-beta" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/repositories/repo-beta/scans?days=30");
    });
  });
});
