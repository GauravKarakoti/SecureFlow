/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import AdminLogsError from "./error";

describe("AdminLogsError Component Isolation Tests (#1527)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createTestError(message: string, digest?: string): Error & { digest?: string } {
    const err = new Error(message) as Error & { digest?: string };
    if (digest) err.digest = digest;
    return err;
  }

  it("renders with default layout headers and structure", () => {
    const reset = vi.fn();
    const error = createTestError("Database connection timeout", "d-logs-101");
    render(<AdminLogsError error={error} reset={reset} />);

    expect(screen.getByTestId("admin-logs-error-boundary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Audit Logs" })).toBeInTheDocument();
    expect(screen.getByText(/System activity, compliance audit trails/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed to load audit logs/i)).toBeInTheDocument();
  });

  it("displays the error digest when available", () => {
    const error = createTestError("Failed query", "d-digest-404");
    render(<AdminLogsError error={error} reset={vi.fn()} />);

    expect(screen.getByTestId("error-digest")).toHaveTextContent("d-digest-404");
  });

  it("does not leak error message contents into the DOM", () => {
    const sensitive = "SELECT * FROM audit_logs WHERE secret_token='SUPER_SECRET_VALUE'";
    const error = createTestError(sensitive, "digest-safe");
    render(<AdminLogsError error={error} reset={vi.fn()} />);

    expect(document.body.textContent).not.toContain("SUPER_SECRET_VALUE");
    expect(document.body.textContent).not.toContain("SELECT * FROM");
  });

  it("invokes reset callback on retry button click", () => {
    const reset = vi.fn();
    const error = createTestError("Network error", "digest-retry");
    render(<AdminLogsError error={error} reset={reset} />);

    const retryButton = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryButton);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
