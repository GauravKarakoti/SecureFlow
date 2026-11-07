/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminLogsLoading from "./loading";

describe("AdminLogsLoading Skeleton Component (#1591)", () => {
  it("renders with aria-busy='true' and an accessible label", () => {
    render(<AdminLogsLoading />);
    const container = screen.getByLabelText("Loading audit logs");
    expect(container).toBeInTheDocument();
    expect(container).toHaveAttribute("aria-busy", "true");
  });

  it("exposes accessible tree metadata and container styling", () => {
    const { container } = render(<AdminLogsLoading />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("aria-label", "Loading audit logs");
    expect(root).toHaveAttribute("aria-busy", "true");
    expect(root).toHaveClass("space-y-8");
  });

  it("renders the header icon and title skeletons", () => {
    const { container } = render(<AdminLogsLoading />);
    const header = container.querySelector(".flex.items-start.gap-4");
    expect(header).toBeInTheDocument();

    const iconSkeleton = header?.querySelector(".h-11.w-11.rounded-xl");
    expect(iconSkeleton).toBeInTheDocument();
    expect(iconSkeleton).toHaveClass("animate-pulse");

    const textSkeletons = header?.querySelectorAll(".space-y-2 .animate-pulse");
    expect(textSkeletons?.length).toBe(2);
    expect(textSkeletons?.[0]).toHaveClass("h-9", "w-48");
    expect(textSkeletons?.[1]).toHaveClass("h-4", "w-96");
  });

  it("renders three metric tiles in sm:grid-cols-3", () => {
    const { container } = render(<AdminLogsLoading />);
    const grid = container.querySelector(".grid.gap-6.sm\\:grid-cols-3");
    expect(grid).toBeInTheDocument();

    const cards = grid?.querySelectorAll(".glass-card");
    expect(cards?.length).toBe(3);

    cards?.forEach((card) => {
      const labelSkeleton = card.querySelector(".mb-3.h-3.w-24");
      const valueSkeleton = card.querySelector(".h-7.w-20");
      expect(labelSkeleton).toBeInTheDocument();
      expect(labelSkeleton).toHaveClass("animate-pulse");
      expect(valueSkeleton).toBeInTheDocument();
      expect(valueSkeleton).toHaveClass("animate-pulse");
    });
  });

  it("renders filter controls and 6 audit log placeholder rows", () => {
    const { container } = render(<AdminLogsLoading />);
    const tableCard = container.querySelectorAll(".glass-card")[3]; // The fourth glass card is the table container
    expect(tableCard).toBeInTheDocument();

    const filterControls = tableCard?.querySelectorAll(".mb-6 .animate-pulse");
    expect(filterControls?.length).toBe(2);
    expect(filterControls?.[0]).toHaveClass("h-10", "w-full", "sm:max-w-xs");
    expect(filterControls?.[1]).toHaveClass("h-10", "w-full", "sm:w-44");

    const rows = tableCard?.querySelectorAll(".space-y-4 .h-10.w-full");
    expect(rows?.length).toBe(6);
    rows?.forEach((row) => {
      expect(row).toHaveClass("animate-pulse");
    });
  });

  it("preserves identical placeholder counts between renders", () => {
    const { container: firstRender } = render(<AdminLogsLoading />);
    const countFirst = firstRender.querySelectorAll(".animate-pulse").length;

    const { container: secondRender } = render(<AdminLogsLoading />);
    const countSecond = secondRender.querySelectorAll(".animate-pulse").length;

    expect(countFirst).toBe(countSecond);
    expect(countFirst).toBe(17);
  });

  it("renders sufficient pulse placeholders to avoid layout shifts", () => {
    const { container } = render(<AdminLogsLoading />);
    const skeletons = container.querySelectorAll(".animate-pulse");
    // 1 icon + 2 header + 3*2 metrics + 2 filters + 6 rows = 17 skeletons
    expect(skeletons.length).toBe(17);
  });

  it("applies glass-card visual container styling to stat and table containers", () => {
    const { container } = render(<AdminLogsLoading />);
    const cards = container.querySelectorAll(".glass-card");
    expect(cards.length).toBe(4); // 3 metric cards + 1 table card
    cards.forEach((card) => {
      expect(card).toHaveClass("glass-card", "rounded-xl", "p-6");
    });
  });

  it("ensures all pulse skeletons have valid layout height classes", () => {
    const { container } = render(<AdminLogsLoading />);
    const pulseElements = container.querySelectorAll(".animate-pulse");
    pulseElements.forEach((el) => {
      const className = el.getAttribute("class") || "";
      expect(className).toMatch(/h-\d+/);
    });
  });
});
