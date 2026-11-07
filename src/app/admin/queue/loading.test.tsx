/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminQueueLoading from "./loading";

describe("AdminQueueLoading Skeleton Component (#1591)", () => {
  it("renders with aria-busy='true' and an accessible label", () => {
    render(<AdminQueueLoading />);
    const container = screen.getByLabelText("Loading queue monitor");
    expect(container).toBeInTheDocument();
    expect(container).toHaveAttribute("aria-busy", "true");
  });

  it("exposes proper accessibility attributes on root container", () => {
    const { container } = render(<AdminQueueLoading />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("aria-label", "Loading queue monitor");
    expect(root).toHaveAttribute("aria-busy", "true");
    expect(root).toHaveClass("space-y-8");
  });

  it("renders the header title and description skeleton blocks", () => {
    const { container } = render(<AdminQueueLoading />);
    const header = container.querySelector(".space-y-2");
    expect(header).toBeInTheDocument();

    const textSkeletons = header?.querySelectorAll(".animate-pulse");
    expect(textSkeletons?.length).toBe(2);
    expect(textSkeletons?.[0]).toHaveClass("h-9", "w-56");
    expect(textSkeletons?.[1]).toHaveClass("h-4", "max-w-full");
  });

  it("renders five queue state stat cards (waiting, active, completed, failed, delayed)", () => {
    const { container } = render(<AdminQueueLoading />);
    const grid = container.querySelector(".grid.gap-6.sm\\:grid-cols-2.lg\\:grid-cols-5");
    expect(grid).toBeInTheDocument();

    const statCards = grid?.querySelectorAll(".glass-card");
    expect(statCards?.length).toBe(5);

    statCards?.forEach((card) => {
      const labelSkeleton = card.querySelector(".h-3.w-20");
      const badgeSkeleton = card.querySelector(".h-4.w-4.rounded-full");
      const countSkeleton = card.querySelector(".h-8.w-14");

      expect(labelSkeleton).toBeInTheDocument();
      expect(badgeSkeleton).toBeInTheDocument();
      expect(countSkeleton).toBeInTheDocument();
      expect(labelSkeleton).toHaveClass("animate-pulse");
      expect(badgeSkeleton).toHaveClass("animate-pulse");
      expect(countSkeleton).toHaveClass("animate-pulse");
    });
  });

  it("renders two queue table sections each with title and 4 rows", () => {
    const { container } = render(<AdminQueueLoading />);
    const allGlassCards = container.querySelectorAll(".glass-card");
    // 5 stat cards + 2 table cards = 7 glass-card elements
    expect(allGlassCards.length).toBe(7);

    const tableCards = [allGlassCards[5], allGlassCards[6]];
    tableCards.forEach((tableCard) => {
      const titleSkeleton = tableCard.querySelector(".mb-6.h-5.w-48");
      expect(titleSkeleton).toBeInTheDocument();
      expect(titleSkeleton).toHaveClass("animate-pulse");

      const rows = tableCard.querySelectorAll(".space-y-4 .h-10.w-full");
      expect(rows.length).toBe(4);
      rows.forEach((row) => {
        expect(row).toHaveClass("animate-pulse");
      });
    });
  });

  it("ensures layout is resilient and maintains structure across remounts", () => {
    const { unmount, container } = render(<AdminQueueLoading />);
    expect(container.querySelectorAll(".glass-card").length).toBe(7);
    unmount();
    const { container: newContainer } = render(<AdminQueueLoading />);
    expect(newContainer.querySelectorAll(".glass-card").length).toBe(7);
  });

  it("renders comprehensive pulse elements to maintain visual structure", () => {
    const { container } = render(<AdminQueueLoading />);
    const allSkeletons = container.querySelectorAll(".animate-pulse");
    // 2 header + 5*3 stat cards + 2*(1 title + 4 rows) = 2 + 15 + 10 = 27 skeletons
    expect(allSkeletons.length).toBe(27);
  });
});
