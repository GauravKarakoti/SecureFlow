/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Calendar } from "./calendar";

describe("Calendar component", () => {
  it("renders calendar with navigation and month caption", () => {
    const testDate = new Date(2026, 7, 19); // August 19, 2026
    render(<Calendar defaultMonth={testDate} mode="single" />);

    expect(screen.getByText(/august 2026/i)).toBeInTheDocument();
  });

  it("handles date selection on click", () => {
    const handleSelect = vi.fn();
    const testDate = new Date(2026, 7, 1);
    render(
      <Calendar
        defaultMonth={testDate}
        mode="single"
        onSelect={handleSelect}
      />
    );

    const day15 = screen.getByText("15");
    fireEvent.click(day15);
    expect(handleSelect).toHaveBeenCalled();
  });

  it("renders custom classNames", () => {
    const testDate = new Date(2026, 7, 1);
    const { container } = render(
      <Calendar
        defaultMonth={testDate}
        className="custom-calendar-root"
      />
    );

    expect(container.querySelector(".custom-calendar-root")).toBeInTheDocument();
  });
});
