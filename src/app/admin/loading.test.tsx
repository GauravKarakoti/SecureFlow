/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminLoading from "./loading";

describe("AdminLoading Skeleton Component (#1591)", () => {
  it("renders with aria-busy='true' and an accessible label", () => {
    render(<AdminLoading />);
    const container = screen.getByLabelText("Loading admin overview");
    expect(container).toBeInTheDocument();
    expect(container).toHaveAttribute("aria-busy", "true");
  });

  it("exposes proper role and accessibility tree information", () => {
    const { container } = render(<AdminLoading />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("aria-label", "Loading admin overview");
    expect(root).toHaveAttribute("aria-busy", "true");
    expect(root).toHaveClass("space-y-10");
  });

  it("renders the heading block skeletons", () => {
    const { container } = render(<AdminLoading />);
    const headingBlock = container.querySelector(".space-y-2");
    expect(headingBlock).toBeInTheDocument();

    const skeletons = headingBlock?.querySelectorAll(".animate-pulse");
    expect(skeletons?.length).toBe(3);
    expect(skeletons?.[0]).toHaveClass("h-4", "w-28");
    expect(skeletons?.[1]).toHaveClass("h-10", "w-72");
    expect(skeletons?.[2]).toHaveClass("h-4", "w-96");
  });

  it("renders three metric tile skeletons in a responsive grid", () => {
    const { container } = render(<AdminLoading />);
    const grid = container.querySelector(".grid.gap-6.md\\:grid-cols-3");
    expect(grid).toBeInTheDocument();

    const cards = grid?.querySelectorAll(".glass-card");
    expect(cards?.length).toBe(3);

    cards?.forEach((card, index) => {
      const iconSkeleton = card.querySelector(".h-10.w-10.rounded-lg");
      expect(iconSkeleton).toBeInTheDocument();
      expect(iconSkeleton).toHaveClass("animate-pulse");

      const textSkeletons = card.querySelectorAll(".flex-1 .animate-pulse");
      expect(textSkeletons.length).toBe(2);
      expect(textSkeletons[0]).toHaveClass("h-3", "w-24");
      expect(textSkeletons[1]).toHaveClass("h-6", "w-16");
    });
  });

  it("renders recent activity table skeleton container with 5 placeholder rows", () => {
    const { container } = render(<AdminLoading />);
    const tableSection = container.querySelector(".space-y-4");
    expect(tableSection).toBeInTheDocument();

    const tableTitleSkeleton = tableSection?.querySelector(".h-7.w-56");
    expect(tableTitleSkeleton).toBeInTheDocument();
    expect(tableTitleSkeleton).toHaveClass("animate-pulse");

    const tableCard = tableSection?.querySelector(".glass-card");
    expect(tableCard).toBeInTheDocument();

    const rows = tableCard?.querySelectorAll(".h-12.w-full");
    expect(rows?.length).toBe(5);
    rows?.forEach((row) => {
      expect(row).toHaveClass("animate-pulse");
    });
  });

  it("preserves layout proportions without crashing on re-render", () => {
    const { unmount, container } = render(<AdminLoading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(15);
    unmount();
    const { container: rerenderedContainer } = render(<AdminLoading />);
    expect(rerenderedContainer.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(
      15,
    );
  });

  it("contains sufficient skeleton elements ensuring smooth layout shift prevention", () => {
    const { container } = render(<AdminLoading />);
    const allSkeletons = container.querySelectorAll(".animate-pulse");
    // 3 heading + 3*3 metrics + 1 table title + 5 rows = 18 skeletons
    expect(allSkeletons.length).toBe(18);
  });

  it("verifies contrast and visual structure styling classes on all placeholder cards", () => {
    const { container } = render(<AdminLoading />);
    const cards = container.querySelectorAll(".glass-card");
    expect(cards.length).toBe(4); // 3 metric cards + 1 table card
    cards.forEach((card) => {
      expect(card).toHaveClass("glass-card", "rounded-xl", "p-6");
    });
  });

  it("ensures all heading and metric skeletons render with valid height classes", () => {
    const { container } = render(<AdminLoading />);
    const pulseElements = container.querySelectorAll(".animate-pulse");
    pulseElements.forEach((el) => {
      const className = el.getAttribute("class") || "";
      expect(className).toMatch(/h-\d+/);
    });
  });
});
