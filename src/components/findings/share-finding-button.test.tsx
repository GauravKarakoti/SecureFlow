/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { ShareFindingButton } from "./share-finding-button";

describe("ShareFindingButton Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders the share button and copies URL on click", async () => {
    vi.useFakeTimers();
    render(<ShareFindingButton findingId="find-123" />);

    const shareBtn = screen.getByRole("button", { name: "Share finding link" });
    expect(shareBtn).toHaveTextContent("Share");

    await act(async () => {
      fireEvent.click(shareBtn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/findings/find-123"),
    );
    expect(screen.getByText("Link Copied!")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText("Share")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
