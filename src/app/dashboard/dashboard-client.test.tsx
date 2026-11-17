/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import DashboardClient from "./dashboard-client";
import * as syncAction from "@/lib/actions/sync-repositories";

// Mock react-countup
vi.mock("react-countup", () => ({
  default: ({ end }: { end: number }) => <span data-testid="countup-value">{end}</span>,
}));

// Mock recharts
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ data, children }: { data: unknown[]; children: React.ReactNode }) => (
    <svg data-testid="area-chart" data-count={data?.length}>
      {children}
    </svg>
  ),
  Area: () => <g data-testid="area-series" />,
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("DashboardClient component (#1446)", () => {
  const defaultProps = {
    stats: {
      totalScans: 48,
      blockedPRs: 5,
      approvedPRs: 40,
      secretsDetected: 3,
    },
    prs: [
      {
        id: "pr-1",
        prNumber: 101,
        title: "feat(auth): add OAuth2 provider support",
        status: "PASS",
        createdAt: "2026-10-20T10:00:00.000Z",
        repository: {
          fullName: "acme-corp/api-gateway",
        },
      },
      {
        id: "pr-2",
        prNumber: 102,
        title: "fix(jwt): resolve potential algorithm confusion vulnerability",
        status: "BLOCKED",
        createdAt: "2026-10-21T12:00:00.000Z",
        repository: {
          fullName: "acme-corp/auth-service",
        },
      },
      {
        id: "pr-3",
        prNumber: 103,
        title: "chore: bump dependencies",
        status: "PENDING",
        createdAt: "2026-10-22T08:30:00.000Z",
        repository: {
          fullName: "acme-corp/frontend",
        },
      },
    ],
    chartData: [
      { date: "2026-10-01", scans: 10 },
      { date: "2026-10-02", scans: 15 },
    ],
    distribution: {
      critical: 2,
      high: 4,
      medium: 8,
      low: 12,
    },
    repoCount: 5,
    needsGitHubAppInstall: false,
    githubAppUrl: "https://github.com/apps/secureflow-scanner",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Header and Stats Hydration", () => {
    it("renders page title, subtitle, and monitoring badge", () => {
      render(<DashboardClient {...defaultProps} />);

      expect(screen.getByText("Risk Overview")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Monitor repository security, scan activity, and pull request health from one place.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("SecureFlow monitoring active")).toBeInTheDocument();
      expect(screen.getByText("• 5 Protected Repositories")).toBeInTheDocument();
    });

    it("omits protected repositories counter when repoCount is zero", () => {
      render(<DashboardClient {...defaultProps} repoCount={0} />);

      expect(screen.queryByText(/Protected Repositories/)).not.toBeInTheDocument();
    });

    it("renders all four stat cards with correct metrics", () => {
      render(<DashboardClient {...defaultProps} />);

      expect(screen.getByText("Total Scans")).toBeInTheDocument();
      expect(screen.getByText("Blocked PRs")).toBeInTheDocument();
      expect(screen.getByText("Approved PRs")).toBeInTheDocument();
      expect(screen.getByText("Secrets Detected")).toBeInTheDocument();

      const values = screen.getAllByTestId("countup-value").map((el) => el.textContent);
      expect(values).toEqual(["48", "5", "40", "3"]);
    });
  });

  describe("GitHub App Onboarding Prompt", () => {
    it("renders onboarding banner when needsGitHubAppInstall is true", () => {
      render(
        <DashboardClient
          {...defaultProps}
          needsGitHubAppInstall={true}
          githubAppUrl="https://github.com/apps/my-app"
        />,
      );

      expect(screen.getByText("Install SecureFlow GitHub Application")).toBeInTheDocument();
      expect(screen.getByText(/Action Required \/\/ Connect Repositories/i)).toBeInTheDocument();

      const link = screen.getByRole("link", { name: /Install GitHub App/i });
      expect(link).toHaveAttribute("href", "https://github.com/apps/my-app");
    });

    it("does not render onboarding banner when needsGitHubAppInstall is false", () => {
      render(<DashboardClient {...defaultProps} needsGitHubAppInstall={false} />);

      expect(screen.queryByText("Install SecureFlow GitHub Application")).not.toBeInTheDocument();
    });
  });

  describe("Scan Activity Chart", () => {
    it("renders chart when scan activity data is provided", () => {
      render(<DashboardClient {...defaultProps} />);

      expect(screen.getByText("Scan Activity")).toBeInTheDocument();
      expect(screen.getByText("Last 30 Days")).toBeInTheDocument();
      expect(screen.getByTestId("area-chart")).toHaveAttribute("data-count", "2");
    });

    it("renders empty state placeholder when chartData is empty", () => {
      render(<DashboardClient {...defaultProps} chartData={[]} />);

      expect(screen.getByText("No Scan Activity")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Run your first repository scan to start visualizing scan activity over time.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe("Severity Distribution", () => {
    it("renders distribution rows with severity counts and percentage bars", () => {
      render(<DashboardClient {...defaultProps} />);

      expect(screen.getByText("Severity Distribution")).toBeInTheDocument();
      expect(screen.getByText("Critical")).toBeInTheDocument();
      expect(screen.getByText("High")).toBeInTheDocument();
      expect(screen.getByText("Medium")).toBeInTheDocument();
      expect(screen.getByText("Low")).toBeInTheDocument();

      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("4")).toBeInTheDocument();
      expect(screen.getByText("8")).toBeInTheDocument();
      expect(screen.getByText("12")).toBeInTheDocument();
    });

    it("renders empty state placeholder when all severity counts are zero", () => {
      render(
        <DashboardClient
          {...defaultProps}
          distribution={{ critical: 0, high: 0, medium: 0, low: 0 }}
        />,
      );

      expect(screen.getByText("No Security Findings")).toBeInTheDocument();
      expect(
        screen.getByText("Severity metrics will appear after your first successful scan."),
      ).toBeInTheDocument();
    });
  });

  describe("Recent Pull Requests Table", () => {
    it("renders list of pull requests with titles, repo names, and statuses", () => {
      render(<DashboardClient {...defaultProps} />);

      expect(screen.getByText("Recent Pull Requests")).toBeInTheDocument();
      expect(screen.getByText("feat(auth): add OAuth2 provider support")).toBeInTheDocument();
      expect(
        screen.getByText("fix(jwt): resolve potential algorithm confusion vulnerability"),
      ).toBeInTheDocument();
      expect(screen.getByText("chore: bump dependencies")).toBeInTheDocument();

      expect(screen.getByText("#101")).toBeInTheDocument();
      expect(screen.getByText("#102")).toBeInTheDocument();
      expect(screen.getByText("#103")).toBeInTheDocument();

      expect(screen.getByText("acme-corp/api-gateway")).toBeInTheDocument();
      expect(screen.getByText("acme-corp/auth-service")).toBeInTheDocument();
      expect(screen.getByText("acme-corp/frontend")).toBeInTheDocument();

      expect(screen.getByText("PASS")).toBeInTheDocument();
      expect(screen.getByText("BLOCKED")).toBeInTheDocument();
      expect(screen.getByText("PENDING")).toBeInTheDocument();
    });

    it("renders empty state placeholder when prs list is empty", () => {
      render(<DashboardClient {...defaultProps} prs={[]} />);

      expect(screen.getByText("No Pull Requests Yet")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Connect a repository and run a scan to view pull requests, security findings, and policy results here.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe("Repository Sync Action", () => {
    it("handles successful repository sync with skipped and failed notes", async () => {
      vi.spyOn(syncAction, "triggerRepositorySync").mockResolvedValue({
        synced: 3,
        skipped: 2,
        skippedRepositories: ["repo-a", "repo-b"],
        failed: 1,
        hasInstallation: true,
      });

      render(<DashboardClient {...defaultProps} />);

      fireEvent.click(screen.getByText("Sync Repositories"));

      await waitFor(() => {
        expect(
          screen.getByText(
            "Successfully synchronized 3 repositories. 2 already tracked by another user (repo-a, repo-b). 1 could not be saved.",
          ),
        ).toBeInTheDocument();
      });
    });

    it("handles response when GitHub App installation is missing", async () => {
      vi.spyOn(syncAction, "triggerRepositorySync").mockResolvedValue({
        synced: 0,
        hasInstallation: false,
      });

      render(<DashboardClient {...defaultProps} />);

      fireEvent.click(screen.getByText("Sync Repositories"));

      await waitFor(() => {
        expect(
          screen.getByText(
            "No GitHub App installation found. Please install the GitHub App first.",
          ),
        ).toBeInTheDocument();
      });
    });

    it("handles response when repositories are already up to date", async () => {
      vi.spyOn(syncAction, "triggerRepositorySync").mockResolvedValue({
        synced: 0,
        hasInstallation: true,
      });

      render(<DashboardClient {...defaultProps} />);

      fireEvent.click(screen.getByText("Sync Repositories"));

      await waitFor(() => {
        expect(screen.getByText("Repositories are up to date.")).toBeInTheDocument();
      });
    });

    it("handles sync action errors gracefully", async () => {
      vi.spyOn(syncAction, "triggerRepositorySync").mockRejectedValue(
        new Error("Network connection failure"),
      );

      render(<DashboardClient {...defaultProps} />);

      fireEvent.click(screen.getByText("Sync Repositories"));

      await waitFor(() => {
        expect(
          screen.getByText("Sync failed. Please check GitHub App permissions."),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Onboarding Checklist Integration (#1787)", () => {
    it("renders OnboardingChecklist when onboardingStatus is supplied", () => {
      render(
        <DashboardClient
          {...defaultProps}
          onboardingStatus={{
            appInstalled: true,
            repoConnected: true,
            webhookReceived: false,
            policyEnabled: true,
            firstScanCompleted: false,
            allComplete: false,
          }}
        />,
      );

      expect(screen.getByTestId("onboarding-checklist")).toBeInTheDocument();
      expect(screen.getByText("Get Started with SecureFlow")).toBeInTheDocument();
      expect(screen.getByText("3 of 5 Complete")).toBeInTheDocument();
    });
  });
});
