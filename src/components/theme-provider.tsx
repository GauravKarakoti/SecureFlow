"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = "secureflow-theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Default stays "dark" so it matches the current look of the app
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  // On first load, read the saved preference from localStorage (if any).
  // This is the standard client-only "mounted" pattern used to avoid a
  // server/client hydration mismatch (see React docs, Next.js docs, and
  // next-themes' own docs, which all use this exact pattern). The new
  // react-hooks/set-state-in-effect rule currently flags this as a false
  // positive with no equivalent alternative yet: https://github.com/react/react/issues/34743
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    const initialTheme = stored === "light" || stored === "dark" ? stored : "dark";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above
    setTheme(initialTheme);
    setMounted(true);
  }, []);

  // Whenever the theme changes, update the <html> class and save it
  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, mounted]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
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