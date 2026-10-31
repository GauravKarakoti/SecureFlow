/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AnalyticsPage from "./page";
import * as authModule from "@/auth";
import * as scanHistoryModule from "@/lib/analytics/scan-history";
import * as rangeModule from "@/lib/analytics/range";
import { redirect } from "next/navigation";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/analytics/scan-history", () => ({
  getAnalyticsPayload: vi.fn(),
}));

vi.mock("@/lib/analytics/range", () => ({
  parseAnalyticsRange: vi.fn((val) => (val === "7" ? 7 : val === "90" ? 90 : 30)),
}));

vi.mock("./analytics-client", () => ({
  default: ({
    rangeDays,
    dailyMetrics,
    severityTrend,
    repoSummaries,
    topFindingTypes,
    scanVelocity,
    summary,
  }: {
    rangeDays: number;
    dailyMetrics: any[];
    severityTrend: any[];
    repoSummaries: any[];
    topFindingTypes: any[];
    scanVelocity: any;
    summary: any;
  }) => (
    <div data-testid="analytics-client">
      <div data-testid="range-days">{rangeDays}</div>
      <div data-testid="total-scans">{summary.totalScans}</div>
      <div data-testid="avg-risk-score">{summary.avgRiskScore}</div>
      <div data-testid="critical-findings">{summary.criticalFindings}</div>
      <div data-testid="high-findings">{summary.highFindings}</div>
      <div data-testid="pass-rate">{summary.passRate}%</div>
      <div data-testid="daily-metrics-count">{dailyMetrics.length}</div>
      <div data-testid="severity-trend-count">{severityTrend.length}</div>
      <div data-testid="repo-summaries-count">{repoSummaries.length}</div>
      <div data-testid="top-findings-count">{topFindingTypes.length}</div>
      <div data-testid="scan-velocity-window">{scanVelocity.windowDays}</div>
      <div data-testid="scan-velocity-per-day">{scanVelocity.scansPerDay}</div>
      <div data-testid="repos-list">
        {repoSummaries.map((repo) => (
          <div key={repo.repositoryId} data-testid="repo-item">
            {repo.fullName}:{repo.totalScans}
          </div>
        ))}
      </div>
    </div>
  ),
}));

describe("AnalyticsPage Server Component (#1469)", () => {
  const mockPayload = {
    dailyMetrics: [
      {
        date: "2026-10-01",
        scansCount: 5,
        passCount: 4,
        reviewCount: 1,
        blockCount: 0,
        criticalCount: 1,
        highCount: 2,
        avgRiskScore: 45,
      },
      {
        date: "2026-10-02",
        scansCount: 8,
        passCount: 6,
        reviewCount: 2,
        blockCount: 0,
        criticalCount: 0,
        highCount: 1,
        avgRiskScore: 35,
      },
    ],
    severityTrend: [
      { date: "2026-10-01", critical: 1, high: 2, medium: 3, low: 4, info: 0 },
      { date: "2026-10-02", critical: 0, high: 1, medium: 2, low: 3, info: 0 },
    ],
    repoSummaries: [
      {
        repositoryId: "repo-1",
        fullName: "owner/frontend-app",
        totalScans: 12,
        avgRiskScore: 42,
        criticalCount: 2,
        highCount: 5,
        lastScanAt: new Date("2026-10-25T10:00:00Z"),
        policyDecision: "PASS",
      },
      {
        repositoryId: "repo-2",
        fullName: "owner/backend-api",
        totalScans: 20,
        avgRiskScore: 68,
        criticalCount: 4,
        highCount: 8,
        lastScanAt: new Date("2026-10-26T12:00:00Z"),
        policyDecision: "REVIEW",
      },
    ],
    topFindingTypes: [
      { type: "HARDCODED_SECRET", count: 15 },
      { type: "SQL_INJECTION", count: 8 },
      { type: "INSECURE_DEPENDENCY", count: 6 },
    ],
    scanVelocity: {
      windowDays: 30,
      scansPerDay: 2.5,
      scansPerWeek: 17.5,
      busiestDay: "2026-10-15",
      busiestDayScanCount: 7,
    },
    summary: {
      totalScans: 32,
      avgRiskScore: 55,
      criticalFindings: 6,
      highFindings: 13,
      passRate: 75,
      blockRate: 10,
      reviewRate: 15,
      activeRepos: 2,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to the sign-in page", async () => {
    vi.mocked(authModule.auth).mockResolvedValue(null);

    await expect(AnalyticsPage({})).rejects.toThrow("REDIRECT:/api/auth/signin");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("redirects when session exists but user.id is missing", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({ user: {} } as any);

    await expect(AnalyticsPage({})).rejects.toThrow("REDIRECT:/api/auth/signin");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("fetches analytics data for authenticated user with default 30-day range", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-456", name: "Alice Developer" },
    } as any);

    vi.mocked(scanHistoryModule.getAnalyticsPayload).mockResolvedValue(mockPayload as any);

    const pageElement = await AnalyticsPage({});
    render(pageElement);

    expect(rangeModule.parseAnalyticsRange).toHaveBeenCalledWith(undefined);
    expect(scanHistoryModule.getAnalyticsPayload).toHaveBeenCalledWith("user-456", 30);

    expect(screen.getByTestId("range-days").textContent).toBe("30");
    expect(screen.getByTestId("total-scans").textContent).toBe("32");
    expect(screen.getByTestId("avg-risk-score").textContent).toBe("55");
    expect(screen.getByTestId("critical-findings").textContent).toBe("6");
    expect(screen.getByTestId("high-findings").textContent).toBe("13");
    expect(screen.getByTestId("pass-rate").textContent).toBe("75%");
    expect(screen.getByTestId("daily-metrics-count").textContent).toBe("2");
    expect(screen.getByTestId("severity-trend-count").textContent).toBe("2");
    expect(screen.getByTestId("repo-summaries-count").textContent).toBe("2");
    expect(screen.getByTestId("top-findings-count").textContent).toBe("3");
    expect(screen.getByTestId("scan-velocity-window").textContent).toBe("30");
    expect(screen.getByTestId("scan-velocity-per-day").textContent).toBe("2.5");

    const repos = screen.getAllByTestId("repo-item");
    expect(repos).toHaveLength(2);
    expect(repos[0].textContent).toBe("owner/frontend-app:12");
    expect(repos[1].textContent).toBe("owner/backend-api:20");
  });

  it("respects searchParams range parameter (7 days)", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-456" },
    } as any);

    vi.mocked(scanHistoryModule.getAnalyticsPayload).mockResolvedValue({
      ...mockPayload,
      scanVelocity: { ...mockPayload.scanVelocity, windowDays: 7 },
    } as any);

    const searchParams = Promise.resolve({ range: "7" });
    const pageElement = await AnalyticsPage({ searchParams });
    render(pageElement);

    expect(rangeModule.parseAnalyticsRange).toHaveBeenCalledWith("7");
    expect(scanHistoryModule.getAnalyticsPayload).toHaveBeenCalledWith("user-456", 7);
    expect(screen.getByTestId("range-days").textContent).toBe("7");
  });

  it("respects searchParams range parameter (90 days)", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-456" },
    } as any);

    vi.mocked(scanHistoryModule.getAnalyticsPayload).mockResolvedValue({
      ...mockPayload,
      scanVelocity: { ...mockPayload.scanVelocity, windowDays: 90 },
    } as any);

    const searchParams = Promise.resolve({ range: "90" });
    const pageElement = await AnalyticsPage({ searchParams });
    render(pageElement);

    expect(rangeModule.parseAnalyticsRange).toHaveBeenCalledWith("90");
    expect(scanHistoryModule.getAnalyticsPayload).toHaveBeenCalledWith("user-456", 90);
    expect(screen.getByTestId("range-days").textContent).toBe("90");
  });

  it("handles empty analytics metrics gracefully without throwing", async () => {
    vi.mocked(authModule.auth).mockResolvedValue({
      user: { id: "user-empty" },
    } as any);

    const emptyPayload = {
      dailyMetrics: [],
      severityTrend: [],
      repoSummaries: [],
      topFindingTypes: [],
      scanVelocity: {
        windowDays: 30,
        scansPerDay: 0,
        scansPerWeek: 0,
        busiestDay: null,
        busiestDayScanCount: 0,
      },
      summary: {
        totalScans: 0,
        avgRiskScore: 0,
        criticalFindings: 0,
        highFindings: 0,
        passRate: 100,
        blockRate: 0,
        reviewRate: 0,
        activeRepos: 0,
      },
    };

    vi.mocked(scanHistoryModule.getAnalyticsPayload).mockResolvedValue(emptyPayload as any);

    const pageElement = await AnalyticsPage({});
    render(pageElement);

    expect(screen.getByTestId("total-scans").textContent).toBe("0");
    expect(screen.getByTestId("daily-metrics-count").textContent).toBe("0");
    expect(screen.getByTestId("repo-summaries-count").textContent).toBe("0");
  });
});
