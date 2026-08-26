/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import InteractiveDemo from "./InteractiveDemo";

// Mock react-countup to render text directly in test environment
vi.mock("react-countup", () => {
  return {
    default: ({ end, suffix }: { end: number; suffix?: string }) => (
      <span data-testid="count-up">
        {end}
        {suffix || ""}
      </span>
    ),
  };
});

describe("InteractiveDemo Component (#632)", () => {
  it("renders with custom numerical metrics correctly", () => {
    render(
      <InteractiveDemo
        prsCount={1500}
        secretsCount={88}
        reposCount={34}
        scanAverage={1.2}
      />
    );

    expect(screen.getByText("PRs Protected")).toBeInTheDocument();
    expect(screen.getByText("Secrets Blocked")).toBeInTheDocument();
    expect(screen.getByText("Scan Average")).toBeInTheDocument();
    expect(screen.getByText("Protected Repos")).toBeInTheDocument();

    const counts = screen.getAllByTestId("count-up");
    expect(counts).toHaveLength(4);
    expect(counts[0].textContent).toBe("1500");
    expect(counts[1].textContent).toBe("88");
    expect(counts[2].textContent).toBe("1.2s");
    expect(counts[3].textContent).toBe("34");
  });

  it("renders with default fallback metrics when no props are passed", () => {
    render(<InteractiveDemo />);

    const counts = screen.getAllByTestId("count-up");
    expect(counts).toHaveLength(4);
    expect(counts[0].textContent).toBe("45208");
    expect(counts[1].textContent).toBe("1842");
    expect(counts[2].textContent).toBe("1.4s");
    expect(counts[3].textContent).toBe("948");
  });

  it("renders mission control terminal header and mission badges", () => {
    render(<InteractiveDemo />);

    expect(screen.getByText("SF_MISSION_CONTROL_TERMINAL")).toBeInTheDocument();
    expect(screen.getByText("Secured")).toBeInTheDocument();
    expect(screen.getByText("Breach Defended")).toBeInTheDocument();
  });
});
