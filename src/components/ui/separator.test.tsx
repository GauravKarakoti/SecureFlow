/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Separator } from "./separator";

describe("Separator component", () => {
  it("renders horizontal separator by default", () => {
    const { container } = render(<Separator />);
    const separator = container.firstChild;
    expect(separator).toHaveAttribute("data-orientation", "horizontal");
    expect(separator).toHaveClass("h-[1px]");
    expect(separator).toHaveClass("w-full");
  });

  it("renders vertical separator when orientation is vertical", () => {
    const { container } = render(<Separator orientation="vertical" />);
    const separator = container.firstChild;
    expect(separator).toHaveAttribute("data-orientation", "vertical");
    expect(separator).toHaveClass("h-full");
    expect(separator).toHaveClass("w-[1px]");
  });

  it("applies custom className", () => {
    const { container } = render(<Separator className="custom-sep" />);
    expect(container.firstChild).toHaveClass("custom-sep");
  });
});
