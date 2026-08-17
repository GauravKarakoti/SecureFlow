/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import RootError from "./error";
import GlobalError from "./global-error";
import NotFound from "./not-found";
import DashboardError from "./dashboard/error";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** A thrown error as the boundaries actually receive it in production. */
function boundaryError(digest?: string): Error & { digest?: string } {
  const error = new Error(
    "Can't reach database server at postgresql://neondb_owner:hunter2@ep-x.neon.tech/neondb"
  ) as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
}

describe("app/error.tsx — root boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a retry affordance wired to reset()", () => {
    const reset = vi.fn();
    render(<RootError error={boundaryError("abc123")} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("shows the digest but never the underlying message", () => {
    // The message on a Prisma failure carries the connection string, password
    // included. The digest is the only detail safe to put on screen.
    render(<RootError error={boundaryError("abc123")} reset={vi.fn()} />);

    expect(screen.getByTestId("error-digest")).toHaveTextContent("abc123");
    expect(document.body.textContent).not.toContain("postgresql://");
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("logs only the digest, so the console is not a second leak", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RootError error={boundaryError("abc123")} reset={vi.fn()} />);

    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("abc123");
    expect(logged).not.toContain("hunter2");
  });

  it("copes with an error that has no digest", () => {
    render(<RootError error={boundaryError()} reset={vi.fn()} />);

    expect(screen.queryByTestId("error-digest")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("app/dashboard/error.tsx — segment boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not offer a dashboard link, since it renders inside the dashboard", () => {
    render(<DashboardError error={boundaryError("d1")} reset={vi.fn()} />);

    expect(screen.queryByRole("link", { name: /back to dashboard/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("reassures the reader that stored data is unaffected", () => {
    render(<DashboardError error={boundaryError("d1")} reset={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toMatch(/findings are unaffected/i);
  });
});

describe("app/not-found.tsx", () => {
  it("renders the 404 code and routes back into the app", () => {
    render(<NotFound />);

    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
  });

  it("offers no retry, because a 404 is not transient", () => {
    render(<NotFound />);

    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});

describe("app/global-error.tsx", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders its own <html> and <body>, because it replaces the root layout", () => {
    // Rendered to static markup rather than into jsdom: this component is a
    // whole document, not a fragment, and mounting it inside an existing <body>
    // would not exercise the thing that matters.
    const markup = renderToStaticMarkup(
      <GlobalError error={boundaryError("g1")} reset={() => {}} />
    );

    expect(markup).toContain("<html");
    expect(markup).toContain("<body");
    expect(markup).toContain('lang="en"');
  });

  it("shows the digest without the message", () => {
    const markup = renderToStaticMarkup(
      <GlobalError error={boundaryError("g1")} reset={() => {}} />
    );

    expect(markup).toContain("g1");
    expect(markup).not.toContain("hunter2");
  });

  it("styles itself inline, since globals.css may not have been applied", () => {
    // It replaces the root layout, so it cannot rely on ThemeProvider,
    // SessionProvider or the stylesheet the layout imports.
    const markup = renderToStaticMarkup(
      <GlobalError error={boundaryError()} reset={() => {}} />
    );

    expect(markup).toContain("style=");
    expect(markup).not.toContain("glass-card");
  });

  it("offers a retry button", () => {
    const markup = renderToStaticMarkup(
      <GlobalError error={boundaryError()} reset={() => {}} />
    );

    expect(markup).toContain("Try again");
    expect(markup).toContain('type="button"');
  });

  it("marks its content as an alert", () => {
    const markup = renderToStaticMarkup(
      <GlobalError error={boundaryError()} reset={() => {}} />
    );

    expect(markup).toContain('role="alert"');
  });
});

describe("loading skeletons", () => {
  it.each([
    ["dashboard", () => import("./dashboard/loading")],
    ["findings", () => import("./dashboard/findings/loading")],
    ["audit", () => import("./dashboard/audit/loading")],
  ])("%s announces a busy region while the queries resolve", async (_name, load) => {
    const { default: Loading } = await load();
    const { container } = render(<Loading />);

    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy).toHaveAttribute("aria-label");
    // A skeleton with no placeholders is just an empty page.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
