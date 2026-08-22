/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton component", () => {
  it("renders with animate-pulse and base styling classes", () => {
    const { container } = render(<Skeleton data-testid="skeleton-element" />);
    const el = container.firstChild;
    expect(el).toHaveClass("animate-pulse");
    expect(el).toHaveClass("rounded-md");
    expect(el).toHaveClass("bg-muted");
  });

  it("applies custom className", () => {
    const { container } = render(<Skeleton className="h-12 w-12 rounded-full" />);
    const el = container.firstChild;
    expect(el).toHaveClass("h-12");
    expect(el).toHaveClass("w-12");
    expect(el).toHaveClass("rounded-full");
  });
});
