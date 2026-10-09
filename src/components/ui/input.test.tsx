/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Input } from "./input";

describe("Input component", () => {
  it("renders input element", () => {
    render(<Input placeholder="Search logs..." />);
    const input = screen.getByPlaceholderText("Search logs...");
    expect(input).toBeInTheDocument();
  });

  it("handles user text input", () => {
    const handleChange = vi.fn();
    render(<Input placeholder="Enter username" onChange={handleChange} />);
    const input = screen.getByPlaceholderText("Enter username");
    fireEvent.change(input, { target: { value: "Professor" } });
    expect(handleChange).toHaveBeenCalled();
  });

  it("supports disabled state", () => {
    render(<Input placeholder="Disabled input" disabled />);
    const input = screen.getByPlaceholderText("Disabled input");
    expect(input).toBeDisabled();
  });
});
