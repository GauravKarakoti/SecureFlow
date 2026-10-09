/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "./badge";

describe("Badge component", () => {
  it("renders children correctly", () => {
    render(<Badge>CRITICAL</Badge>);
    expect(screen.getByText("CRITICAL")).toBeInTheDocument();
  });

  it("applies default variant styling", () => {
    const { container } = render(<Badge>Default</Badge>);
    expect(container.firstChild).toHaveClass("bg-primary");
  });

  it("applies custom variant styling", () => {
    const { container } = render(<Badge variant="destructive">High Risk</Badge>);
    expect(container.firstChild).toHaveClass("bg-destructive");
  });

  it("merges custom className props", () => {
    const { container } = render(<Badge className="custom-badge-class">Custom</Badge>);
    expect(container.firstChild).toHaveClass("custom-badge-class");
  });
});
