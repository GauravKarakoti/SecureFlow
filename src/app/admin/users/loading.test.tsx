/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminUsersLoading from "./loading";

describe("AdminUsersLoading Skeleton Component (#1591)", () => {
  it("renders with aria-busy='true' and an accessible label", () => {
    render(<AdminUsersLoading />);
    const container = screen.getByLabelText("Loading user management");
    expect(container).toBeInTheDocument();
    expect(container).toHaveAttribute("aria-busy", "true");
  });

  it("exposes accessible tree attributes and root container styling", () => {
    const { container } = render(<AdminUsersLoading />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("aria-label", "Loading user management");
    expect(root).toHaveAttribute("aria-busy", "true");
    expect(root).toHaveClass("space-y-8");
  });

  it("renders the header icon and title skeletons", () => {
    const { container } = render(<AdminUsersLoading />);
    const header = container.querySelector(".flex.items-start.gap-4");
    expect(header).toBeInTheDocument();

    const iconSkeleton = header?.querySelector(".h-11.w-11.rounded-xl");
    expect(iconSkeleton).toBeInTheDocument();
    expect(iconSkeleton).toHaveClass("animate-pulse");

    const textSkeletons = header?.querySelectorAll(".space-y-2 .animate-pulse");
    expect(textSkeletons?.length).toBe(2);
    expect(textSkeletons?.[0]).toHaveClass("h-9", "w-56");
    expect(textSkeletons?.[1]).toHaveClass("h-4", "max-w-full");
  });

  it("renders three user metric stat cards", () => {
    const { container } = render(<AdminUsersLoading />);
    const grid = container.querySelector(".grid.gap-6.sm\\:grid-cols-2.lg\\:grid-cols-3");
    expect(grid).toBeInTheDocument();

    const cards = grid?.querySelectorAll(".glass-card");
    expect(cards?.length).toBe(3);

    cards?.forEach((card) => {
      const labelSkeleton = card.querySelector(".mb-3.h-3.w-24");
      const valueSkeleton = card.querySelector(".h-7.w-16");
      expect(labelSkeleton).toBeInTheDocument();
      expect(labelSkeleton).toHaveClass("animate-pulse");
      expect(valueSkeleton).toBeInTheDocument();
      expect(valueSkeleton).toHaveClass("animate-pulse");
    });
  });

  it("renders user search bar skeleton and 5 user rows with avatar placeholders", () => {
    const { container } = render(<AdminUsersLoading />);
    const allGlassCards = container.querySelectorAll(".glass-card");
    // 3 metric cards + 1 table card = 4
    expect(allGlassCards.length).toBe(4);

    const tableCard = allGlassCards[3];
    const searchSkeleton = tableCard.querySelector(".mb-6.h-10");
    expect(searchSkeleton).toBeInTheDocument();
    expect(searchSkeleton).toHaveClass("animate-pulse");

    const rows = tableCard.querySelectorAll(".space-y-4 .flex.items-center.gap-4");
    expect(rows.length).toBe(5);

    rows.forEach((row) => {
      const avatarSkeleton = row.querySelector(".h-10.w-10.rounded-full");
      const contentSkeleton = row.querySelector(".h-10.flex-1");
      expect(avatarSkeleton).toBeInTheDocument();
      expect(avatarSkeleton).toHaveClass("animate-pulse");
      expect(contentSkeleton).toBeInTheDocument();
      expect(contentSkeleton).toHaveClass("animate-pulse");
    });
  });

  it("matches visual structure consistently across rerenders", () => {
    const { unmount, container: first } = render(<AdminUsersLoading />);
    expect(first.querySelectorAll(".animate-pulse").length).toBe(20);
    unmount();
    const { container: second } = render(<AdminUsersLoading />);
    expect(second.querySelectorAll(".animate-pulse").length).toBe(20);
  });

  it("renders sufficient pulse placeholders to avoid user management layout shifts", () => {
    const { container } = render(<AdminUsersLoading />);
    const allSkeletons = container.querySelectorAll(".animate-pulse");
    // 1 icon + 2 header + 3*2 metrics + 1 search + 5*2 user rows = 3 + 6 + 1 + 10 = 20 skeletons
    expect(allSkeletons.length).toBe(20);
  });
});
