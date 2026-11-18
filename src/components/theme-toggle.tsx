"use client";

import React, { useState, useEffect } from "react";
import { Sun, Moon, Laptop, Check } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ThemeToggleProps {
  className?: string;
}

/**
 * ThemeToggle Component
 *
 * Provides Light, Dark, and System theme options in the application header.
 * Persists choice in local storage and reflects the active choice with an indicator.
 */
export function ThemeToggle({ className = "" }: ThemeToggleProps) {
  const { theme, resolvedTheme = "dark", setTheme = () => {} } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const handleSelect = (selectedTheme: "light" | "dark" | "system") => {
    setTheme(selectedTheme);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild onClick={() => setOpen((prev) => !prev)}>
        <button
          type="button"
          aria-label="Toggle theme"
          title={`Theme: ${theme}`}
          className={`w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
          data-testid="theme-toggle-trigger"
        >
          {mounted ? (
            resolvedTheme === "dark" ? (
              <Moon className="w-4 h-4 transition-transform duration-200" />
            ) : (
              <Sun className="w-4 h-4 transition-transform duration-200" />
            )
          ) : (
            <span className="w-4 h-4" />
          )}
          <span className="sr-only">Toggle theme</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36 font-sans">
        <DropdownMenuItem
          onClick={() => handleSelect("light")}
          className="flex items-center justify-between cursor-pointer"
          data-testid="theme-option-light"
        >
          <div className="flex items-center gap-2">
            <Sun className="w-4 h-4 text-amber-500" />
            <span>Light</span>
          </div>
          {theme === "light" && <Check className="w-3.5 h-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleSelect("dark")}
          className="flex items-center justify-between cursor-pointer"
          data-testid="theme-option-dark"
        >
          <div className="flex items-center gap-2">
            <Moon className="w-4 h-4 text-indigo-400" />
            <span>Dark</span>
          </div>
          {theme === "dark" && <Check className="w-3.5 h-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleSelect("system")}
          className="flex items-center justify-between cursor-pointer"
          data-testid="theme-option-system"
        >
          <div className="flex items-center gap-2">
            <Laptop className="w-4 h-4 text-muted-foreground" />
            <span>System</span>
          </div>
          {theme === "system" && <Check className="w-3.5 h-3.5 text-primary" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export default ThemeToggle;
