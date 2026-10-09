/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch component", () => {
  it("renders switch with switch role", () => {
    render(<Switch aria-label="Toggle notifications" />);
    const switchEl = screen.getByRole("switch", { name: /toggle notifications/i });
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toHaveAttribute("data-state", "unchecked");
  });

  it("handles toggling switch state", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Toggle notifications" onCheckedChange={onCheckedChange} />);
    const switchEl = screen.getByRole("switch", { name: /toggle notifications/i });

    fireEvent.click(switchEl);
    expect(onCheckedChange).toHaveBeenCalled();
  });

  it("supports disabled state", () => {
    render(<Switch disabled aria-label="Disabled switch" />);
    const switchEl = screen.getByRole("switch", { name: /disabled switch/i });
    expect(switchEl).toBeDisabled();
  });

  it("applies custom className", () => {
    const { container } = render(<Switch className="custom-switch" />);
    expect(container.firstChild).toHaveClass("custom-switch");
  });
});
