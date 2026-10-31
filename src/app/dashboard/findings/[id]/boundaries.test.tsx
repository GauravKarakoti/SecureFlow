/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import FindingDetailError from "./error";
import RemediationError from "./remediation/error";
import FindingDetailLoading from "./loading";
import RemediationLoading from "./remediation/loading";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** A thrown error as the boundary actually receives it in production. */
function boundaryError(digest?: string): Error & { digest?: string } {
  const error = new Error(
    "Can't reach database server at postgresql://neondb_owner:hunter2@ep-x.neon.tech/neondb",
  ) as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe.each([
  ["findings/[id]/error.tsx", FindingDetailError],
  ["findings/[id]/remediation/error.tsx", RemediationError],
])("%s - segment boundary (#1468)", (_name, Boundary) => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an alert with a retry button wired to reset()", () => {
    const reset = vi.fn();
    render(<Boundary error={boundaryError("d1")} reset={reset} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the digest but never the underlying message", () => {
    render(<Boundary error={boundaryError("d1")} reset={vi.fn()} />);

    expect(screen.getByTestId("error-digest")).toHaveTextContent("d1");
    expect(document.body.textContent).not.toContain("postgresql://");
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("logs only the digest, so the console is not a second leak", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Boundary error={boundaryError("d1")} reset={vi.fn()} />);

    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("d1");
    expect(logged).not.toContain("hunter2");
  });

  it("does not offer a dashboard link, since it renders inside the dashboard layout", () => {
    render(<Boundary error={boundaryError("d1")} reset={vi.fn()} />);

    expect(screen.queryByRole("link", { name: /back to dashboard/i })).not.toBeInTheDocument();
  });

  it("copes with an error that has no digest", () => {
    render(<Boundary error={boundaryError()} reset={vi.fn()} />);

    expect(screen.queryByTestId("error-digest")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("finding detail loading skeletons (#1468)", () => {
  it.each([
    ["finding detail", FindingDetailLoading],
    ["remediation", RemediationLoading],
  ])("%s announces a busy region while the page resolves", (_name, Loading) => {
    const { container } = render(<Loading />);

    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy).toHaveAttribute("aria-label");
    // A skeleton with no placeholders is just an empty page.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
