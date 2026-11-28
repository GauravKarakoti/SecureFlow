/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RepositoriesClient from "./repositories-client";
import type { RepositoriesOverviewData } from "@/lib/repositories/types";

describe("RepositoriesClient Component (#1870)", () => {
  const mockData: RepositoriesOverviewData = {
    totalConnected: 3,
    averageHealthScore: 82,
    totalOpenCritical: 1,
    totalOpenHigh: 2,
    totalBlockedPrs30Days: 2,
    cachedAt: Date.now(),
    repositories: [
      {
        id: "repo-alpha",
        fullName: "acme/alpha-service",
        owner: "acme",
        hasScans: true,
        lastScanAt: "2026-11-19T10:00:00Z",
        openFindings: {
          critical: 0,
          high: 1,
          medium: 2,
          low: 0,
          info: 0,
          total: 3,
        },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: 3600000,
        medianResolveTimeFormatted: "1.0h",
        healthScore: 92,
        healthTier: "EXCELLENT",
        trend: [
          { week: 1, weekLabel: "W1", score: 85 },
          { week: 8, weekLabel: "W8", score: 92 },
        ],
      },
      {
        id: "repo-beta",
        fullName: "acme/beta-worker",
        owner: "acme",
        hasScans: true,
        lastScanAt: "2026-11-18T14:00:00Z",
        openFindings: {
          critical: 1,
          high: 1,
          medium: 0,
          low: 0,
          info: 0,
          total: 2,
        },
        blockedPrsLast30Days: 2,
        medianResolveTimeMs: 24 * 3600 * 1000,
        medianResolveTimeFormatted: "1.0d",
        healthScore: 72,
        healthTier: "NEEDS_ATTENTION",
        trend: [
          { week: 1, weekLabel: "W1", score: 65 },
          { week: 8, weekLabel: "W8", score: 72 },
        ],
      },
      {
        id: "repo-gamma",
        fullName: "acme/gamma-unscanned",
        owner: "acme",
        hasScans: false,
        lastScanAt: null,
        openFindings: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          info: 0,
          total: 0,
        },
        blockedPrsLast30Days: 0,
        medianResolveTimeMs: null,
        medianResolveTimeFormatted: "—",
        healthScore: null,
        healthTier: "UNRANKED",
        trend: [
          { week: 1, weekLabel: "W1", score: null },
          { week: 8, weekLabel: "W8", score: null },
        ],
      },
    ],
  };

  it("renders page header and summary metric cards", () => {
    render(<RepositoriesClient initialData={mockData} />);

    expect(screen.getByText("Repository Security Overview")).toBeDefined();
    expect(screen.getByText("Connected Repos")).toBeDefined();
    expect(screen.getByText("Avg Health Score")).toBeDefined();
    expect(screen.getByText("Open Critical & High")).toBeDefined();
    expect(screen.getAllByText("Blocked PRs (30d)").length).toBeGreaterThanOrEqual(1);

    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1); // totalConnected and findings
    expect(screen.getByText("82")).toBeDefined(); // averageHealthScore
  });

  it("renders repository rows with badges, finding counts, and pre-filtered links", () => {
    render(<RepositoriesClient initialData={mockData} />);

    // Repository names
    expect(screen.getByText("acme/alpha-service")).toBeDefined();
    expect(screen.getByText("acme/beta-worker")).toBeDefined();
    expect(screen.getByText("acme/gamma-unscanned")).toBeDefined();

    // Health badges
    expect(screen.getByText(/92 \/ 100 · Excellent/)).toBeDefined();
    expect(screen.getByText(/72 \/ 100 · Needs Attention/)).toBeDefined();
    expect(screen.getAllByText("Unranked (No Scans)").length).toBeGreaterThanOrEqual(1);

    // Verify link to findings table pre-filtered by repo id
    const links = screen.getAllByRole("link");
    const alphaLinks = links.filter((l) =>
      l.getAttribute("href")?.includes("/dashboard/findings?repo=repo-alpha"),
    );
    expect(alphaLinks.length).toBeGreaterThan(0);
  });

  it("toggles scoring formula documentation section", () => {
    render(<RepositoriesClient initialData={mockData} />);

    expect(screen.queryByText("Repository Health Score Calculation")).toBeNull();

    const formulaBtn = screen.getByText("Scoring Formula");
    fireEvent.click(formulaBtn);

    expect(screen.getByText("Repository Health Score Calculation")).toBeDefined();
    expect(screen.getByText(/Findings Penalty/)).toBeDefined();

    fireEvent.click(screen.getByText("Hide Formula"));
    expect(screen.queryByText("Repository Health Score Calculation")).toBeNull();
  });

  it("filters repositories by search term", () => {
    render(<RepositoriesClient initialData={mockData} />);

    const searchInput = screen.getByPlaceholderText(/Search repositories/i);
    fireEvent.change(searchInput, { target: { value: "beta" } });

    expect(screen.getByText("acme/beta-worker")).toBeDefined();
    expect(screen.queryByText("acme/alpha-service")).toBeNull();
    expect(screen.queryByText("acme/gamma-unscanned")).toBeNull();
  });

  it("filters repositories by tier dropdown", () => {
    render(<RepositoriesClient initialData={mockData} />);

    const selects = screen.getAllByRole("combobox");
    const tierSelect = selects[0]; // first select is tier filter

    // Select UNRANKED
    fireEvent.change(tierSelect, { target: { value: "UNRANKED" } });

    expect(screen.getByText("acme/gamma-unscanned")).toBeDefined();
    expect(screen.queryByText("acme/alpha-service")).toBeNull();
    expect(screen.queryByText("acme/beta-worker")).toBeNull();
  });

  it("handles empty repositories state gracefully", () => {
    const emptyData: RepositoriesOverviewData = {
      totalConnected: 0,
      averageHealthScore: null,
      totalOpenCritical: 0,
      totalOpenHigh: 0,
      totalBlockedPrs30Days: 0,
      cachedAt: Date.now(),
      repositories: [],
    };

    render(<RepositoriesClient initialData={emptyData} />);
    expect(screen.getByText("No Connected Repositories")).toBeDefined();
    expect(screen.getByText("Connect Repository Wizard")).toBeDefined();
    expect(screen.getByText("Go to Settings")).toBeDefined();

    // Clicking Connect Repository Wizard in empty state opens the wizard
    fireEvent.click(screen.getByTestId("empty-connect-repo-btn"));
    expect(screen.getByTestId("connect-repo-wizard")).toBeDefined();
  });

  it("opens Connect Repository Wizard when header button is clicked", () => {
    render(<RepositoriesClient initialData={mockData} />);

    const connectBtn = screen.getByTestId("connect-repo-btn");
    expect(connectBtn).toBeDefined();

    fireEvent.click(connectBtn);
    expect(screen.getByTestId("connect-repo-wizard")).toBeDefined();
    expect(screen.getByText("Connect Repository Wizard")).toBeDefined();
  });
});
