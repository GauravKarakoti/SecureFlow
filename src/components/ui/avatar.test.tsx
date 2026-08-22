/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Avatar, AvatarImage, AvatarFallback } from "./avatar";

describe("Avatar component", () => {
  it("renders avatar root and fallback text", () => {
    render(
      <Avatar>
        <AvatarImage src="https://github.com/octocat.png" alt="Octocat" />
        <AvatarFallback>OC</AvatarFallback>
      </Avatar>
    );

    expect(screen.getByText("OC")).toBeInTheDocument();
  });

  it("applies custom className to Avatar root", () => {
    const { container } = render(
      <Avatar className="custom-avatar-class">
        <AvatarFallback>SF</AvatarFallback>
      </Avatar>
    );

    expect(container.firstChild).toHaveClass("custom-avatar-class");
    expect(container.firstChild).toHaveClass("rounded-full");
  });

  it("applies custom className to AvatarFallback", () => {
    render(
      <Avatar>
        <AvatarFallback className="custom-fallback">AB</AvatarFallback>
      </Avatar>
    );

    expect(screen.getByText("AB")).toHaveClass("custom-fallback");
  });
});
