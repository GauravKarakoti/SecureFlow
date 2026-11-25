/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PolicyEffectivenessCard } from "./policy-effectiveness-card";
import type { PolicyEffectivenessSummary } from "@/lib/policies/effectiveness";

describe("PolicyEffectivenessCard Component (#2019)", () => {
  const mockSummary: PolicyEffectivenessSummary = {
    periodDays: 30,
    totalPolicies: 3,
    activePolicies: 3,
    noisyPolicies: 1,
    inactivePolicies: 1,
    healthyPolicies: 1,
    totalFindingsEvaluated: 6,
    overallFalsePositiveRate: 50,
    overallResolvedRate: 33.3,
    policies: [
      {
        policyId: "pol-1",
        policyName: "Noisy SQL Policy",
        description: "Detects unescaped SQL fragments",
        severity: "HIGH",
        isActive: true,
        totalFindings: 4,
        falsePositiveCount: 3,
        falsePositiveRate: 75,
        resolvedCount: 1,
        resolvedRate: 25,
        openCount: 0,
        avgResolutionTimeMs: 14400000,
        avgResolutionTimeFormatted: "4.0h",
        status: "noisy",
      },
      {
        policyId: "pol-2",
        policyName: "Inactive Secret Rule",
        description: "Catches exposed private tokens",
        severity: "CRITICAL",
        isActive: true,
        totalFindings: 0,
        falsePositiveCount: 0,
        falsePositiveRate: 0,
        resolvedCount: 0,
        resolvedRate: 0,
        openCount: 0,
        avgResolutionTimeMs: null,
        avgResolutionTimeFormatted: "—",
        status: "inactive",
      },
      {
        policyId: "pol-3",
        policyName: "Healthy Dependency Policy",
        description: "Enforces safe lockfile versions",
        severity: "MEDIUM",
        isActive: true,
        totalFindings: 2,
        falsePositiveCount: 0,
        falsePositiveRate: 0,
        resolvedCount: 2,
        resolvedRate: 100,
        openCount: 0,
        avgResolutionTimeMs: 7200000,
        avgResolutionTimeFormatted: "2.0h",
        status: "healthy",
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSummary,
    } as any);
  });

  it("renders with initialData correctly without fetching", () => {
    render(<PolicyEffectivenessCard initialData={mockSummary} />);

    expect(screen.getByText("Policy Effectiveness Report")).toBeInTheDocument();
    expect(screen.getByTestId("metric-total-policies")).toHaveTextContent("3");
    expect(screen.getByTestId("metric-noisy-policies")).toHaveTextContent("1");
    expect(screen.getByTestId("metric-inactive-policies")).toHaveTextContent("1");
    expect(screen.getByTestId("metric-healthy-policies")).toHaveTextContent("1");

    // Check status badges
    expect(screen.getByTestId("badge-status-pol-1")).toHaveTextContent("Noisy");
    expect(screen.getByTestId("badge-status-pol-2")).toHaveTextContent("Inactive");
    expect(screen.getByTestId("badge-status-pol-3")).toHaveTextContent("Healthy");

    // CSV export link
    const exportBtn = screen.getByTestId("export-csv-btn");
    expect(exportBtn).toHaveAttribute("href", "/api/policies/effectiveness/export?days=30");
  });

  it("fetches data on mount when initialData is not provided", async () => {
    render(<PolicyEffectivenessCard />);

    await waitFor(() => {
      expect(screen.getByText("Noisy SQL Policy")).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/policies/effectiveness?days=30");
  });

  it("switches evaluation period and updates export URL", async () => {
    render(<PolicyEffectivenessCard initialData={mockSummary} />);

    const btn7d = screen.getByTestId("period-btn-7");
    fireEvent.click(btn7d);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/policies/effectiveness?days=7");
    });

    const exportBtn = screen.getByTestId("export-csv-btn");
    expect(exportBtn).toHaveAttribute("href", "/api/policies/effectiveness/export?days=7");
  });

  it("filters policies by status button", async () => {
    render(<PolicyEffectivenessCard initialData={mockSummary} />);

    expect(screen.getByText("Noisy SQL Policy")).toBeInTheDocument();
    expect(screen.getByText("Inactive Secret Rule")).toBeInTheDocument();
    expect(screen.getByText("Healthy Dependency Policy")).toBeInTheDocument();

    // Click Noisy filter
    const noisyBtn = screen.getByTestId("filter-status-noisy");
    fireEvent.click(noisyBtn);

    expect(screen.getByText("Noisy SQL Policy")).toBeInTheDocument();
    expect(screen.queryByText("Inactive Secret Rule")).not.toBeInTheDocument();
    expect(screen.queryByText("Healthy Dependency Policy")).not.toBeInTheDocument();

    // Click Inactive filter
    const inactiveBtn = screen.getByTestId("filter-status-inactive");
    fireEvent.click(inactiveBtn);

    expect(screen.queryByText("Noisy SQL Policy")).not.toBeInTheDocument();
    expect(screen.getByText("Inactive Secret Rule")).toBeInTheDocument();
    expect(screen.queryByText("Healthy Dependency Policy")).not.toBeInTheDocument();
  });

  it("filters policies by search text", async () => {
    render(<PolicyEffectivenessCard initialData={mockSummary} />);

    const searchInput = screen.getByTestId("policy-search-input");
    fireEvent.change(searchInput, { target: { value: "secret" } });

    expect(screen.queryByText("Noisy SQL Policy")).not.toBeInTheDocument();
    expect(screen.getByText("Inactive Secret Rule")).toBeInTheDocument();
    expect(screen.queryByText("Healthy Dependency Policy")).not.toBeInTheDocument();
  });

  it("handles fetch failure gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as any);

    render(<PolicyEffectivenessCard />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load effectiveness data/i)).toBeInTheDocument();
    });
  });
});
