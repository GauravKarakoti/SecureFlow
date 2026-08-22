/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Checkbox } from "./checkbox";

describe("Checkbox component", () => {
  it("renders checkbox with role checkbox", () => {
    render(<Checkbox aria-label="Accept terms" />);
    const checkbox = screen.getByRole("checkbox", { name: /accept terms/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
  });

  it("toggles state on click", () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Toggle setting" onCheckedChange={onCheckedChange} />);
    const checkbox = screen.getByRole("checkbox", { name: /toggle setting/i });

    fireEvent.click(checkbox);
    expect(onCheckedChange).toHaveBeenCalled();
  });

  it("respects disabled attribute", () => {
    render(<Checkbox disabled aria-label="Disabled option" />);
    const checkbox = screen.getByRole("checkbox", { name: /disabled option/i });
    expect(checkbox).toBeDisabled();
  });

  it("applies custom className", () => {
    const { container } = render(<Checkbox className="custom-checkbox" />);
    expect(container.querySelector(".custom-checkbox")).toBeInTheDocument();
  });
});
