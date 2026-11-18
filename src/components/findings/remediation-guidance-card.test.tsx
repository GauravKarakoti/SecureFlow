/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { RemediationGuidanceCard } from "./remediation-guidance-card";

describe("RemediationGuidanceCard Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders custom remediation guidance text", () => {
    render(<RemediationGuidanceCard remediation="Use parameterized queries instead." />);

    expect(screen.getByText("Remediation Guidance")).toBeInTheDocument();
    expect(screen.getByText("Use parameterized queries instead.")).toBeInTheDocument();
  });

  it("falls back to default guidance when remediation is null or empty", () => {
    render(<RemediationGuidanceCard remediation={null} />);

    expect(
      screen.getByText(
        "Follow standard security practices to sanitize input and isolate privileges.",
      ),
    ).toBeInTheDocument();
  });

  it("copies remediation guidance to clipboard and toggles copied feedback", async () => {
    vi.useFakeTimers();
    render(<RemediationGuidanceCard remediation="Sanitize all inputs before saving." />);

    const copyBtn = screen.getByRole("button", { name: "Copy remediation suggestion" });
    expect(copyBtn).toHaveTextContent("Copy Fix");

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Sanitize all inputs before saving.",
    );
    expect(screen.getByText("Copied")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText("Copy Fix")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
