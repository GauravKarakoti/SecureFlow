/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import AdminQueueError from "./error";

describe("AdminQueueError Component Isolation Tests (#1527)", () => {
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

  it("renders with queue monitor headings and description", () => {
    const reset = vi.fn();
    const error = createTestError("Redis connection refused", "q-digest-201");
    render(<AdminQueueError error={error} reset={reset} />);

    expect(screen.getByTestId("admin-queue-error-boundary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Queue Management" })).toBeInTheDocument();
    expect(screen.getByText(/Monitor background jobs, worker health/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed to load queue metrics/i)).toBeInTheDocument();
  });

  it("safely presents digest while redacting redis host or port info", () => {
    const redisErr = "ECONNREFUSED rediss://default:redispassword123@redis-cluster.internal:6379";
    const error = createTestError(redisErr, "q-digest-safe-2");
    render(<AdminQueueError error={error} reset={vi.fn()} />);

    expect(screen.getByTestId("error-digest")).toHaveTextContent("q-digest-safe-2");
    expect(document.body.textContent).not.toContain("redispassword123");
    expect(document.body.textContent).not.toContain("redis-cluster.internal");
  });

  it("triggers reset callback when user clicks try again", () => {
    const reset = vi.fn();
    const error = createTestError("Timeout communicating with BullMQ", "q-retry-1");
    render(<AdminQueueError error={error} reset={reset} />);

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryBtn);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
