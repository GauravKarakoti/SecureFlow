/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Progress } from "./progress";

describe("Progress component", () => {
  it("renders progress bar with progressbar role", () => {
    render(<Progress value={60} aria-label="Loading progress" />);
    const progress = screen.getByRole("progressbar", { name: /loading progress/i });
    expect(progress).toBeInTheDocument();
  });

  it("handles null/undefined value gracefully", () => {
    render(<Progress aria-label="Indeterminate" />);
    const progress = screen.getByRole("progressbar", { name: /indeterminate/i });
    expect(progress).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(<Progress value={40} className="custom-progress" />);
    expect(container.firstChild).toHaveClass("custom-progress");
  });
});
