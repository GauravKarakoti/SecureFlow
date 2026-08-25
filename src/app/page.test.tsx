/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import LandingPage from "./page";
import * as landingStatsModule from "@/lib/metrics/landing-stats";

vi.mock("@/components/landing/InteractiveDemo", () => {
  return {
    default: ({
      prsCount,
      secretsCount,
      reposCount,
      scanAverage,
    }: {
      prsCount: number;
      secretsCount: number;
      reposCount: number;
      scanAverage: number;
    }) => (
      <div data-testid="interactive-demo">
        <span data-testid="demo-prs">{prsCount}</span>
        <span data-testid="demo-secrets">{secretsCount}</span>
        <span data-testid="demo-repos">{reposCount}</span>
        <span data-testid="demo-average">{scanAverage}</span>
      </div>
    ),
  };
});

vi.mock("@/components/ui/login-button", () => ({
  LoginButton: () => <button data-testid="login-button">Login</button>,
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

describe("LandingPage Component (#632)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches and feeds database metrics to InteractiveDemo", async () => {
    vi.spyOn(landingStatsModule, "getLandingStats").mockResolvedValue({
      prsCount: 154,
      secretsCount: 22,
      reposCount: 8,
      scanAverage: 1.4,
      isLive: true,
    });

    const pageElement = await LandingPage();
    render(pageElement);

    expect(screen.getByText("The Digital Heist")).toBeInTheDocument();
    expect(screen.getByText("Defense System")).toBeInTheDocument();
    expect(screen.getByTestId("demo-prs").textContent).toBe("154");
    expect(screen.getByTestId("demo-secrets").textContent).toBe("22");
    expect(screen.getByTestId("demo-repos").textContent).toBe("8");
    expect(screen.getByTestId("demo-average").textContent).toBe("1.4");
  });

  it("falls back cleanly to baseline numbers if metrics fetching degrades", async () => {
    vi.spyOn(landingStatsModule, "getLandingStats").mockResolvedValue({
      prsCount: 45208,
      secretsCount: 1842,
      reposCount: 948,
      scanAverage: 1.4,
      isLive: false,
    });

    const pageElement = await LandingPage();
    render(pageElement);

    expect(screen.getByTestId("demo-prs").textContent).toBe("45208");
    expect(screen.getByTestId("demo-secrets").textContent).toBe("1842");
    expect(screen.getByTestId("demo-repos").textContent).toBe("948");
  });
});
