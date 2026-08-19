/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Textarea } from "./textarea";

describe("Textarea component", () => {
  it("renders textarea element", () => {
    render(<Textarea placeholder="Enter code snippet" />);
    const textarea = screen.getByPlaceholderText("Enter code snippet");
    expect(textarea).toBeInTheDocument();
  });

  it("handles text input and changes", () => {
    const handleChange = vi.fn();
    render(<Textarea placeholder="Enter notes" onChange={handleChange} />);
    const textarea = screen.getByPlaceholderText("Enter notes");

    fireEvent.change(textarea, { target: { value: "Security finding notes" } });
    expect(handleChange).toHaveBeenCalled();
  });

  it("supports disabled state", () => {
    render(<Textarea disabled placeholder="Disabled field" />);
    const textarea = screen.getByPlaceholderText("Disabled field");
    expect(textarea).toBeDisabled();
  });

  it("merges custom className", () => {
    render(<Textarea placeholder="Custom" className="custom-textarea-class" />);
    const textarea = screen.getByPlaceholderText("Custom");
    expect(textarea).toHaveClass("custom-textarea-class");
  });
});
