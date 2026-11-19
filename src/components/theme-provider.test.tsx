/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { ThemeProvider, useTheme, STORAGE_KEY, getSystemTheme } from "./theme-provider";

function TestConsumer() {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="current-theme">{theme}</span>
      <span data-testid="resolved-theme">{resolvedTheme}</span>
      <button onClick={() => setTheme("light")} data-testid="set-light">
        Light
      </button>
      <button onClick={() => setTheme("dark")} data-testid="set-dark">
        Dark
      </button>
      <button onClick={() => setTheme("system")} data-testid="set-system">
        System
      </button>
      <button onClick={toggleTheme} data-testid="toggle-theme">
        Toggle
      </button>
    </div>
  );
}

describe("ThemeProvider and useTheme", () => {
  let mediaQueryListeners: Array<(e: MediaQueryListEvent) => void> = [];
  let matchesDark = true;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.className = "";
    mediaQueryListeners = [];
    matchesDark = true;

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: matchesDark,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
        if (event === "change") mediaQueryListeners.push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
        mediaQueryListeners = mediaQueryListeners.filter((h) => h !== handler);
      }),
      dispatchEvent: vi.fn(),
    }));
  });

  it("defaults to system preference when local storage is empty and saves choice", () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("current-theme")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
  });

  it("resolves to light when system prefers light mode and no storage is set", () => {
    matchesDark = false;

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("current-theme")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("restores stored light theme preference from local storage", () => {
    localStorage.setItem(STORAGE_KEY, "light");

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("current-theme")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("restores stored dark theme preference from local storage", () => {
    localStorage.setItem(STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("current-theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("allows changing theme to light, dark, and system via setTheme", () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    // Switch to light
    act(() => {
      screen.getByTestId("set-light").click();
    });
    expect(screen.getByTestId("current-theme")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");

    // Switch to dark
    act(() => {
      screen.getByTestId("set-dark").click();
    });
    expect(screen.getByTestId("current-theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");

    // Switch to system
    act(() => {
      screen.getByTestId("set-system").click();
    });
    expect(screen.getByTestId("current-theme")).toHaveTextContent("system");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
  });

  it("supports toggleTheme to switch between dark and light", () => {
    localStorage.setItem(STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");

    act(() => {
      screen.getByTestId("toggle-theme").click();
    });
    expect(screen.getByTestId("current-theme")).toHaveTextContent("light");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");

    act(() => {
      screen.getByTestId("toggle-theme").click();
    });
    expect(screen.getByTestId("current-theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");
  });

  it("updates resolvedTheme when system preference changes dynamically in system mode", () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("dark");

    // Simulate system switching from dark to light
    act(() => {
      mediaQueryListeners.forEach((listener) =>
        listener({ matches: false } as MediaQueryListEvent),
      );
    });

    expect(screen.getByTestId("resolved-theme")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("getSystemTheme helper detects prefers-color-scheme", () => {
    matchesDark = true;
    expect(getSystemTheme()).toBe("dark");

    matchesDark = false;
    expect(getSystemTheme()).toBe("light");
  });

  it("throws error when useTheme is called outside ThemeProvider", () => {
    const renderOutside = () => render(<TestConsumer />);
    expect(renderOutside).toThrow("useTheme must be used within a ThemeProvider");
  });
});
