import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AnalyticsClient from "./analytics-client";

const mockProps = {
  dailyMetrics: [
    { date: "Aug 1", scans: 3, findings: 5, criticalFindings: 1, avgRiskScore: 45.2 },
    { date: "Aug 2", scans: 2, findings: 3, criticalFindings: 0, avgRiskScore: 22.0 },
    { date: "Aug 3", scans: 5, findings: 8, criticalFindings: 2, avgRiskScore: 67.8 },
  ],
  severityTrend: [
    { date: "Aug 1", critical: 1, high: 2, medium: 1, low: 1 },
    { date: "Aug 2", critical: 0, high: 1, medium: 1, low: 1 },
    { date: "Aug 3", critical: 2, high: 3, medium: 2, low: 1 },
  ],
  repoSummaries: [
    {
      repositoryId: "repo-1",
      repositoryName: "acme/backend-api",
      totalScans: 15,
      totalFindings: 23,
      criticalFindings: 3,
      highFindings: 8,
      mediumFindings: 7,
      lowFindings: 5,
      averageRiskScore: 52.3,
      lastScanAt: "2026-08-30T10:00:00Z",
      passRate: 73,
    },
    {
      repositoryId: "repo-2",
      repositoryName: "acme/frontend",
      totalScans: 10,
      totalFindings: 5,
      criticalFindings: 0,
      highFindings: 1,
      mediumFindings: 2,
      lowFindings: 2,
      averageRiskScore: 18.5,
      lastScanAt: "2026-08-29T14:00:00Z",
      passRate: 90,
    },
  ],
  topFindingTypes: [
    { type: "SECRET", count: 15, percentage: 42.0 },
    { type: "VULNERABILITY", count: 12, percentage: 33.5 },
    { type: "MISCONFIG", count: 9, percentage: 24.5 },
  ],
  scanVelocity: [
    { period: "Aug 1", count: 3 },
    { period: "Aug 2", count: 2 },
    { period: "Aug 3", count: 5 },
  ],
  summary: {
    totalScans: 156,
    totalFindings: 89,
    totalPRs: 42,
    overallPassRate: 78,
    avgRiskScore: 34.5,
    trendDirection: "down" as const,
  },
};

describe("AnalyticsClient", () => {
  it("renders the page title", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("Analytics & Trends")).toBeTruthy();
  });

  it("renders the subtitle", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(
      screen.getByText(/Deep dive into scan history/)
    ).toBeTruthy();
  });

  it("renders all four summary stat cards", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("Total Scans")).toBeTruthy();
    expect(screen.getByText("Total Findings")).toBeTruthy();
    expect(screen.getByText("Pass Rate")).toBeTruthy();
    expect(screen.getByText("Avg Risk Score")).toBeTruthy();
  });

  it("renders chart section headers", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("Scan Activity & Findings")).toBeTruthy();
    expect(screen.getByText("Severity Trend Over Time")).toBeTruthy();
    expect(screen.getByText("Top Finding Types")).toBeTruthy();
    expect(screen.getByText("Repository Comparison")).toBeTruthy();
  });

  it("renders repository names in the comparison table", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("acme/backend-api")).toBeTruthy();
    expect(screen.getByText("acme/frontend")).toBeTruthy();
  });

  it("renders finding type labels", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("SECRET")).toBeTruthy();
    expect(screen.getByText("VULNERABILITY")).toBeTruthy();
    expect(screen.getByText("MISCONFIG")).toBeTruthy();
  });

  it("renders export buttons", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("Export CSV")).toBeTruthy();
    expect(screen.getByText("Export JSON")).toBeTruthy();
  });

  it("shows trend direction", () => {
    render(<AnalyticsClient {...mockProps} />);
    expect(screen.getByText("Finding trends decreasing")).toBeTruthy();
  });

  it("renders empty state when no data", () => {
    const emptyProps = {
      ...mockProps,
      dailyMetrics: [],
      severityTrend: [],
      repoSummaries: [],
      topFindingTypes: [],
      scanVelocity: [],
    };
    render(<AnalyticsClient {...emptyProps} />);
    expect(screen.getByText("No Scan Data")).toBeTruthy();
    expect(screen.getByText("No Repositories")).toBeTruthy();
  });

  it("shows 'Show All' button when more than 5 repos", () => {
    const manyRepos = {
      ...mockProps,
      repoSummaries: Array.from({ length: 8 }, (_, i) => ({
        ...mockProps.repoSummaries[0],
        repositoryId: `repo-${i}`,
        repositoryName: `org/repo-${i}`,
      })),
    };
    render(<AnalyticsClient {...manyRepos} />);
    expect(screen.getByText(/Show All/)).toBeTruthy();
  });

  it("renders severity badges in table", () => {
    render(<AnalyticsClient {...mockProps} />);
    // The risk score badge should appear
    expect(screen.getByText("52.3")).toBeTruthy();
    expect(screen.getByText("18.5")).toBeTruthy();
    // Pass rate badges
    expect(screen.getByText("73%")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
  });
});
