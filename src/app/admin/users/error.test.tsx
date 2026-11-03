/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import AdminUsersError from "./error";

describe("AdminUsersError Component Isolation Tests (#1527)", () => {
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

  it("renders with user administration headings and details", () => {
    const reset = vi.fn();
    const error = createTestError("Prisma client failed to query User table", "u-digest-301");
    render(<AdminUsersError error={error} reset={reset} />);

    expect(screen.getByTestId("admin-users-error-boundary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "User Management" })).toBeInTheDocument();
    expect(screen.getByText(/Manage member accounts, assign RBAC privileges/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed to load user management/i)).toBeInTheDocument();
  });

  it("safely presents digest without leaking table names or credentials", () => {
    const sensitive = "Raw query failed: select password_hash from users where role = 'ADMIN'";
    const error = createTestError(sensitive, "u-digest-safe-3");
    render(<AdminUsersError error={error} reset={vi.fn()} />);

    expect(screen.getByTestId("error-digest")).toHaveTextContent("u-digest-safe-3");
    expect(document.body.textContent).not.toContain("password_hash");
    expect(document.body.textContent).not.toContain("from users");
  });

  it("fires reset handler when retry action is triggered", () => {
    const reset = vi.fn();
    const error = createTestError("Transient error", "u-retry-1");
    render(<AdminUsersError error={error} reset={reset} />);

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryBtn);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
