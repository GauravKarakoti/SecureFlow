/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AdminError from "./error";

describe("root admin error boundary (#1551)", () => {
  const privateMessage =
    "Database failed: postgresql://private-user:private-password@database.invalid/admin";

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function errorWithDigest(digest?: string): Error & { digest?: string } {
    return Object.assign(new Error(privateMessage), digest === undefined ? {} : { digest });
  }

  it("renders an accessible, actionable fallback without exposing the underlying error", () => {
    render(<AdminError error={errorWithDigest("admin-ref-123")} reset={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This admin view failed to load",
    );
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
    expect(screen.getByText(/use the sidebar/)).toBeInTheDocument();
    expect(screen.getByTestId("error-digest")).toHaveTextContent("admin-ref-123");
    expect(screen.queryByRole("link", { name: /dashboard/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(privateMessage);
    expect(document.body.textContent).not.toContain("private-password");
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[SecureFlow] admin error",
      "admin-ref-123",
    );
  });

  it.each([undefined, ""])("keeps retry available without a visible digest (%s)", (digest) => {
    const reset = vi.fn();
    render(<AdminError error={errorWithDigest(digest)} reset={reset} />);
    expect(screen.queryByTestId("error-digest")).not.toBeInTheDocument();
    expect(screen.getByRole("heading")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[SecureFlow] admin error", digest ?? "(no digest)");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-password");
  });

  it("invokes the current reset callback after the boundary receives a new error", () => {
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    const { rerender } = render(
      <AdminError error={errorWithDigest("first-ref")} reset={firstReset} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    rerender(<AdminError error={errorWithDigest("second-ref")} reset={secondReset} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(firstReset).toHaveBeenCalledTimes(1);
    expect(secondReset).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("error-digest")).toHaveTextContent("second-ref");
    expect(console.error).toHaveBeenLastCalledWith("[SecureFlow] admin error", "second-ref");
  });
});
