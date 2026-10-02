/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Footer } from "./footer";

vi.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, ...props }: { alt: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("Footer component", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all three navigation column headings", () => {
    render(<Footer />);
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getByText("Community")).toBeInTheDocument();
    expect(screen.getByText("Legal & Trust")).toBeInTheDocument();
  });

  it("renders the brand name and tagline", () => {
    render(<Footer />);
    expect(screen.getByText("SecureFlow")).toBeInTheDocument();
    expect(screen.getByText(/The vault is empty\. Zero traces left behind\./)).toBeInTheDocument();
  });

  it("links legal pages to their routes", () => {
    render(<Footer />);
    expect(screen.getByText("Privacy Policy")).toHaveAttribute("href", "/privacy");
    expect(screen.getByText("Terms of Service")).toHaveAttribute("href", "/terms");
    expect(screen.getByText("Security Policies")).toHaveAttribute("href", "/security");
  });

  it("opens external links in a new tab with rel protection", () => {
    render(<Footer />);
    const [githubIconLink] = screen.getAllByLabelText("GitHub");
    expect(githubIconLink).toHaveAttribute("target", "_blank");
    expect(githubIconLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders accessible labels for the social icon links", () => {
    render(<Footer />);
    expect(screen.getAllByLabelText("GitHub").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Twitter / X").length).toBeGreaterThan(0);
  });

  it("derives the copyright year from the current date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-04-09T00:00:00Z"));

    render(<Footer />);
    expect(screen.getByText(/© 2031 SecureFlow Inc\. All rights reserved\./)).toBeInTheDocument();
  });
});
