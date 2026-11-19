/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SeverityBadge } from "./severity-badge";

describe("SeverityBadge Component", () => {
  it("renders with role='status' and accessible aria-label", () => {
    render(<SeverityBadge severity="CRITICAL" />);
    const badge = screen.getByRole("status");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Severity: CRITICAL - Interpol Breach");
    expect(badge).toHaveTextContent("Interpol Breach");
  });

  it("does not rely on color alone by including an accessible icon", () => {
    const { container } = render(<SeverityBadge severity="HIGH" />);
    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("Hostage Crisis");
    // Verify an icon with aria-hidden="true" is present
    const icon = container.querySelector("svg");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("normalizes severity aliases and non-canonical casing", () => {
    render(<SeverityBadge severity="warning" />);
    const badge = screen.getByRole("status");
    expect(badge).toHaveAttribute("aria-label", "Severity: MEDIUM - Camera Glitch");
    expect(badge).toHaveTextContent("Camera Glitch");
  });

  it("renders with showCanonical flag displaying both canonical and themed names", () => {
    render(<SeverityBadge severity="LOW" showCanonical />);
    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("LOW: Loose Screws");
  });

  it("handles null and undefined gracefully with NONE fallback", () => {
    render(<SeverityBadge severity={null} />);
    const badge = screen.getByRole("status");
    expect(badge).toHaveAttribute("aria-label", "Severity: NONE - All Clear");
    expect(badge).toHaveTextContent("All Clear");
  });

  it("applies high contrast class pairings for WCAG AA compliance", () => {
    render(<SeverityBadge severity="CRITICAL" data-testid="crit-badge" />);
    const badge = screen.getByTestId("crit-badge");
    // Verifies bg-red-700 / dark:bg-red-600 and text-white
    expect(badge.className).toContain("bg-red-700");
    expect(badge.className).toContain("text-white");
  });
});
