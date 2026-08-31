/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import DashboardClient from "./dashboard-client";
import * as syncAction from "@/lib/actions/sync-repositories";

// Mock CountUp
vi.mock("react-countup", () => ({
  default: ({ end }: { end: number }) => <span>{end}</span>,
}));

// Mock recharts
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => <div />,
}));

describe("Dashboard Repository Sync & GitHub App Banner (#634)", () => {
  const baseProps = {
    stats: { totalScans: 12, blockedPRs: 2, approvedPRs: 10, secretsDetected: 1 },
    prs: [],
    chartData: [],
    distribution: { critical: 1, high: 0, medium: 0, low: 0 },
    repoCount: 3,
    needsGitHubAppInstall: false,
    githubAppUrl: "https://github.com/apps/secureflow-app",
  };

  it("renders repo count and monitoring active status", () => {
    render(<DashboardClient {...baseProps} />);

    expect(screen.getByText("Risk Overview")).toBeInTheDocument();
    expect(screen.getByText("• 3 Protected Repositories")).toBeInTheDocument();
    expect(screen.getByText("Sync Repositories")).toBeInTheDocument();
  });

  it("displays GitHub App install prompt when needsGitHubAppInstall is true (Scenario 2)", () => {
    render(
      <DashboardClient
        {...baseProps}
        repoCount={0}
        needsGitHubAppInstall={true}
      />
    );

    expect(screen.getByText("Install SecureFlow GitHub Application")).toBeInTheDocument();
    expect(screen.getByText("Install GitHub App")).toBeInTheDocument();
  });

  it("triggers manual sync when Sync Repositories button is clicked", async () => {
    vi.spyOn(syncAction, "triggerRepositorySync").mockResolvedValue({
      synced: 4,
      hasInstallation: true,
      installationId: 12345,
    });

    render(<DashboardClient {...baseProps} />);

    const syncButton = screen.getByText("Sync Repositories");
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(
        screen.getByText("Successfully synchronized 4 repositories.")
      ).toBeInTheDocument();
    });
  });
});
