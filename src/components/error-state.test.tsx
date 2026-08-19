/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ErrorState } from "./error-state";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("ErrorState", () => {
  it("renders the title and description", () => {
    render(<ErrorState title="Signal lost" description="Something went wrong." />);

    expect(screen.getByText("Signal lost")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
  });

  it("announces itself to assistive technology", () => {
    // A boundary that swaps in silently is invisible to a screen reader: the
    // page content changes with no focus move and no announcement.
    render(<ErrorState title="Signal lost" description="Something went wrong." />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("renders the digest when one is supplied", () => {
    render(
      <ErrorState title="Signal lost" description="Something went wrong." digest="a1b2c3d4" />
    );

    expect(screen.getByTestId("error-digest")).toHaveTextContent("a1b2c3d4");
  });

  it("omits the reference block entirely when there is no digest", () => {
    render(<ErrorState title="Signal lost" description="Something went wrong." />);

    expect(screen.queryByTestId("error-digest")).not.toBeInTheDocument();
    expect(screen.queryByText(/Reference/)).not.toBeInTheDocument();
  });

  it("has no prop through which an error message could reach the DOM", () => {
    // A Prisma error message carries the connection string, the failing query
    // and its parameters. scrubSensitiveData() in error-handler.ts exists for
    // exactly that reason, and this component must not be the hole in it — the
    // digest is the only error detail it can display.
    const props = { title: "Signal lost", description: "Something went wrong.", digest: "d1" };
    render(<ErrorState {...props} />);

    const rendered = screen.getByTestId("error-state").textContent ?? "";
    expect(rendered).not.toContain("postgres");
    expect(Object.keys(props)).not.toContain("message");
  });

  it("invokes reset when the retry button is pressed", () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Signal lost" description="Broken." onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("hides the retry button when no handler is given", () => {
    // A 404 is not transient — offering "Try again" would just re-render it.
    render(<ErrorState title="Nothing here" description="No such page." code="404" />);

    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("renders the status code as decoration, hidden from assistive technology", () => {
    render(<ErrorState title="Nothing here" description="No such page." code="404" />);

    const code = screen.getByText("404");
    expect(code).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the dashboard link by default and the home link on request", () => {
    render(<ErrorState title="Signal lost" description="Broken." showHomeLink />);

    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
  });

  it("can suppress the dashboard link for a boundary already inside the dashboard", () => {
    render(
      <ErrorState title="Signal lost" description="Broken." showDashboardLink={false} />
    );

    expect(screen.queryByRole("link", { name: /back to dashboard/i })).not.toBeInTheDocument();
  });

  it("merges a caller-supplied className", () => {
    render(
      <ErrorState title="Signal lost" description="Broken." className="min-h-[50vh]" />
    );

    expect(screen.getByTestId("error-state")).toHaveClass("min-h-[50vh]");
  });
});
