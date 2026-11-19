"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const STORAGE_KEY = "secureflow-theme";

/**
 * Resolves the user's OS color scheme preference.
 */
export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");
  const [mounted, setMounted] = useState(false);

  // Synchronize on mount from localStorage (defaulting to "system")
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    const initialTheme: Theme =
      stored === "light" || stored === "dark" || stored === "system" ? stored : "system";

    const resolved: ResolvedTheme = initialTheme === "system" ? getSystemTheme() : initialTheme;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeState(initialTheme);

    setResolvedTheme(resolved);

    setMounted(true);

    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);

    // Save default if not set
    if (!stored) {
      localStorage.setItem(STORAGE_KEY, "system");
    }
  }, []);

  // Update theme, local storage, and DOM class
  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(STORAGE_KEY, newTheme);

    const resolved: ResolvedTheme = newTheme === "system" ? getSystemTheme() : newTheme;
    setResolvedTheme(resolved);

    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
  }, []);

  // When theme is "system", listen for system color-scheme changes
  useEffect(() => {
    if (!mounted || theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      const isDark = typeof e?.matches === "boolean" ? e.matches : mediaQuery.matches;
      const resolved: ResolvedTheme = isDark ? "dark" : "light";
      setResolvedTheme(resolved);
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(resolved);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme, mounted]);

  // Toggle function for quick cycling or command palette integration
  const toggleTheme = useCallback(() => {
    const nextTheme: Theme = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
  }, [resolvedTheme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
export default ThemeProvider;
