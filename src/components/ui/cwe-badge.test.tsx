/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CweBadge } from "./cwe-badge";

describe("CweBadge Component (#2008)", () => {
  it("renders badge with link to MITRE definition when cwe is provided", () => {
    render(<CweBadge cwe="CWE-798" />);

    const badge = screen.getByTestId("cwe-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("CWE-798");

    const link = screen.getByRole("link", { name: /view definition for cwe-798/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://cwe.mitre.org/data/definitions/798.html");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("normalizes lowercase cwe input", () => {
    render(<CweBadge cwe="cwe-89" />);

    const badge = screen.getByTestId("cwe-badge");
    expect(badge).toHaveTextContent("CWE-89");

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://cwe.mitre.org/data/definitions/89.html");
  });

  it("renders plain badge without link when showLink is false", () => {
    render(<CweBadge cwe="CWE-78" showLink={false} />);

    const badge = screen.getByTestId("cwe-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("CWE-78");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders null gracefully when cwe is undefined or null (existing findings without CWE)", () => {
    const { container: container1 } = render(<CweBadge cwe={undefined} />);
    expect(container1.firstChild).toBeNull();

    const { container: container2 } = render(<CweBadge cwe={null} />);
    expect(container2.firstChild).toBeNull();

    const { container: container3 } = render(<CweBadge cwe="" />);
    expect(container3.firstChild).toBeNull();
  });
});
