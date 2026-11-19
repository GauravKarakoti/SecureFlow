/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { ThemeProvider } from "./theme-provider";
import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.className = "";

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("renders the theme toggle button with accessibility attributes", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("data-testid", "theme-toggle-trigger");
  });

  it("opens the dropdown menu and displays Light, Dark, and System options", async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const trigger = screen.getByTestId("theme-toggle-trigger");
    fireEvent.click(trigger);

    expect(await screen.findByTestId("theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-dark")).toBeInTheDocument();
    expect(screen.getByTestId("theme-option-system")).toBeInTheDocument();

    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.getByText("Dark")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("allows selecting Light mode and updates document element and local storage", async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const trigger = screen.getByTestId("theme-toggle-trigger");
    fireEvent.click(trigger);

    const lightOption = await screen.findByTestId("theme-option-light");
    act(() => {
      fireEvent.click(lightOption);
    });

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("secureflow-theme")).toBe("light");
  });

  it("allows selecting Dark mode and updates document element and local storage", async () => {
    localStorage.setItem("secureflow-theme", "light");

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const trigger = screen.getByTestId("theme-toggle-trigger");
    fireEvent.click(trigger);

    const darkOption = await screen.findByTestId("theme-option-dark");
    act(() => {
      fireEvent.click(darkOption);
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(localStorage.getItem("secureflow-theme")).toBe("dark");
  });

  it("allows selecting System mode to follow system preference", async () => {
    localStorage.setItem("secureflow-theme", "light");

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    const trigger = screen.getByTestId("theme-toggle-trigger");
    fireEvent.click(trigger);

    const systemOption = await screen.findByTestId("theme-option-system");
    act(() => {
      fireEvent.click(systemOption);
    });

    expect(localStorage.getItem("secureflow-theme")).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
