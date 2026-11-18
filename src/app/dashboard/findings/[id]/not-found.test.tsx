/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import FindingNotFound from "./not-found";

describe("FindingNotFound page component", () => {
  it("renders not found title and descriptive explanation", () => {
    render(<FindingNotFound />);

    expect(screen.getByText("Finding Not Found")).toBeInTheDocument();
    expect(
      screen.getByText(
        /The security finding you are looking for does not exist, may have been deleted, or you do not have permission to access it\./i,
      ),
    ).toBeInTheDocument();
  });

  it("provides a link to navigate back to the findings dashboard", () => {
    render(<FindingNotFound />);

    const backLink = screen.getByRole("link", { name: /Back to Findings/i });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute("href", "/dashboard/findings");
  });
});
