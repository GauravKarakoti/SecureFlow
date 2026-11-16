/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CommandPalette, fuzzyMatch } from "./command-palette";
import * as nextAuth from "next-auth/react";
import * as navigation from "next/navigation";
import * as themeProvider from "@/components/theme-provider";

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(() => "/dashboard"),
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: vi.fn(),
}));

describe("fuzzyMatch helper", () => {
  it("matches substrings case-insensitively", () => {
    expect(fuzzyMatch("find", "Go to Breach Attempts (Findings)")).toBe(true);
    expect(fuzzyMatch("BREACH", "Defense Strategy (Breach Attempts)")).toBe(true);
    expect(fuzzyMatch("xyz", "Mission Control")).toBe(false);
  });

  it("matches through keywords", () => {
    expect(fuzzyMatch("vulnerability", "Breach Attempts", ["vulnerabilities", "security"])).toBe(
      true,
    );
    expect(fuzzyMatch("slack", "Settings", ["webhooks", "slack", "teams"])).toBe(true);
  });

  it("supports sequential characters", () => {
    expect(fuzzyMatch("mctrl", "Mission Control")).toBe(true);
  });

  it("returns true on empty query", () => {
    expect(fuzzyMatch("", "Anything")).toBe(true);
    expect(fuzzyMatch("   ", "Anything")).toBe(true);
  });
});

describe("CommandPalette component", () => {
  const pushMock = vi.fn();
  const toggleThemeMock = vi.fn();

  const standardUserSession = {
    user: {
      id: "u-1",
      name: "Neo",
      email: "neo@secureflow.test",
      roles: ["USER"],
    },
  };

  const adminUserSession = {
    user: {
      id: "a-1",
      name: "Morpheus",
      email: "admin@secureflow.test",
      roles: ["ADMIN", "USER"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(navigation.useRouter).mockReturnValue({
      push: pushMock,
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    } as any);

    vi.mocked(themeProvider.useTheme).mockReturnValue({
      theme: "dark",
      toggleTheme: toggleThemeMock,
    });

    vi.mocked(nextAuth.useSession).mockReturnValue({
      data: standardUserSession as any,
      status: "authenticated",
      update: vi.fn(),
    });
  });

  it("opens with Ctrl+K and closes with Esc", () => {
    render(<CommandPalette />);

    // Initially closed
    expect(screen.queryByRole("dialog", { name: "Command Palette" })).not.toBeInTheDocument();

    // Trigger Ctrl+K
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });

    expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Type a command or search/i)).toBeInTheDocument();

    // Trigger Esc
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(screen.queryByRole("dialog", { name: "Command Palette" })).not.toBeInTheDocument();
  });

  it("opens with Cmd+K (Meta+K) on Mac", () => {
    render(<CommandPalette />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeInTheDocument();
  });

  it("filters entries based on input query", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText(/Type a command or search/i);

    // Initial state shows navigation and actions
    expect(screen.getByText("Go to Mission Control")).toBeInTheDocument();
    expect(screen.getByText("Go to Breach Attempts (Findings)")).toBeInTheDocument();
    expect(screen.getByText("Go to Defense Strategy (Policies)")).toBeInTheDocument();

    // Search for "policies"
    fireEvent.change(searchInput, { target: { value: "policies" } });

    expect(screen.getByText("Go to Defense Strategy (Policies)")).toBeInTheDocument();
    expect(screen.queryByText("Go to Mission Control")).not.toBeInTheDocument();
  });

  it("shows 'No matching commands found' when query has no matches", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    const searchInput = screen.getByPlaceholderText(/Type a command or search/i);
    fireEvent.change(searchInput, { target: { value: "nonexistent-query-12345" } });

    expect(screen.getByText("No matching commands found.")).toBeInTheDocument();
  });

  it("navigates on Enter and closes the palette", () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    const searchInput = screen.getByPlaceholderText(/Type a command or search/i);

    // Filter to Findings
    fireEvent.change(searchInput, { target: { value: "findings" } });

    // Press Enter
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(pushMock).toHaveBeenCalledWith("/dashboard/findings");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("navigates using ArrowDown and ArrowUp keys", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    const dialog = screen.getByRole("dialog");

    // Press ArrowDown
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    // Second item (Findings) should now be selected
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    // Press ArrowUp
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("allows selecting an action by click", () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open={true} onOpenChange={onOpenChange} />);

    const settingsOption = screen.getByText("Go to Settings");
    fireEvent.click(settingsOption);

    expect(pushMock).toHaveBeenCalledWith("/dashboard/settings");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("executes action items like toggle theme", () => {
    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    const themeOption = screen.getByText(/Toggle Theme/i);
    fireEvent.click(themeOption);

    expect(toggleThemeMock).toHaveBeenCalledTimes(1);
  });

  it("hides admin entries for standard non-admin users", () => {
    vi.mocked(nextAuth.useSession).mockReturnValue({
      data: standardUserSession as any,
      status: "authenticated",
      update: vi.fn(),
    });

    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    expect(screen.queryByText("Go to Admin Portal")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin: User Management")).not.toBeInTheDocument();
    expect(screen.queryByText("Admin: Queue Monitor")).not.toBeInTheDocument();
  });

  it("displays admin entries for users with ADMIN role", () => {
    vi.mocked(nextAuth.useSession).mockReturnValue({
      data: adminUserSession as any,
      status: "authenticated",
      update: vi.fn(),
    });

    render(<CommandPalette open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Go to Admin Portal")).toBeInTheDocument();
    expect(screen.getByText("Admin: User Management")).toBeInTheDocument();
    expect(screen.getByText("Admin: Queue Monitor")).toBeInTheDocument();

    // Clicking an admin entry navigates to admin route
    fireEvent.click(screen.getByText("Go to Admin Portal"));
    expect(pushMock).toHaveBeenCalledWith("/admin");
  });
});
