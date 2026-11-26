"use client";

import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from "react";
import { SlidersHorizontal, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DensityLevel = "comfortable" | "compact";

export type OptionalColumnKey =
  | "type"
  | "file"
  | "cwe"
  | "language"
  | "age"
  | "assignee"
  | "issue"
  | "notes";

export type RequiredColumnKey = "severity" | "status";

export type ColumnKey = RequiredColumnKey | OptionalColumnKey;

export interface ColumnDefinition {
  key: ColumnKey;
  label: string;
  required?: boolean;
}

export const COLUMNS_CONFIG: ColumnDefinition[] = [
  { key: "severity", label: "Severity", required: true },
  { key: "status", label: "Status", required: true },
  { key: "type", label: "Vulnerability Type" },
  { key: "file", label: "File Location" },
  { key: "cwe", label: "CWE" },
  { key: "language", label: "Language" },
  { key: "age", label: "Age" },
  { key: "assignee", label: "Assignee" },
  { key: "issue", label: "GitHub Issue" },
  { key: "notes", label: "Reviewer Notes" },
];

export const DEFAULT_VISIBLE_COLUMNS: Record<ColumnKey, boolean> = {
  severity: true,
  status: true,
  type: true,
  file: true,
  cwe: true,
  language: true,
  age: true,
  assignee: true,
  issue: true,
  notes: true,
};

export const DEFAULT_DENSITY: DensityLevel = "comfortable";

export interface TablePreferences {
  visibleColumns: Record<ColumnKey, boolean>;
  density: DensityLevel;
}

export const DEFAULT_PREFERENCES: TablePreferences = {
  visibleColumns: DEFAULT_VISIBLE_COLUMNS,
  density: DEFAULT_DENSITY,
};

export const STORAGE_KEY_PREFIX = "secureflow:findings:table-preferences";

export function getPreferencesStorageKey(userId?: string | null): string {
  return `${STORAGE_KEY_PREFIX}:${userId || "default"}`;
}

export function loadStoredPreferences(userId?: string | null): TablePreferences {
  if (typeof window === "undefined" || !window.localStorage) {
    return DEFAULT_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(getPreferencesStorageKey(userId));
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw);
    const visibleColumns = {
      ...DEFAULT_VISIBLE_COLUMNS,
      ...(parsed.visibleColumns || {}),
      // Required columns can never be hidden
      severity: true,
      status: true,
    };
    const density: DensityLevel =
      parsed.density === "compact" || parsed.density === "comfortable"
        ? parsed.density
        : DEFAULT_DENSITY;
    return { visibleColumns, density };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveStoredPreferences(
  preferences: TablePreferences,
  userId?: string | null
): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    // Ensure required columns remain true when saving
    const sanitized: TablePreferences = {
      visibleColumns: {
        ...preferences.visibleColumns,
        severity: true,
        status: true,
      },
      density: preferences.density,
    };
    window.localStorage.setItem(
      getPreferencesStorageKey(userId),
      JSON.stringify(sanitized)
    );
  } catch {
    // Ignore storage quota or disabled storage errors
  }
}

export interface FindingsTablePreferencesContextType {
  preferences: TablePreferences;
  toggleColumn: (key: ColumnKey) => void;
  setDensity: (density: DensityLevel) => void;
  resetPreferences: () => void;
}

const FindingsTablePreferencesContext =
  createContext<FindingsTablePreferencesContextType | null>(null);

export function useFindingsTablePreferences(): FindingsTablePreferencesContextType {
  const context = useContext(FindingsTablePreferencesContext);
  if (!context) {
    throw new Error(
      "useFindingsTablePreferences must be used within a FindingsTablePreferencesProvider"
    );
  }
  return context;
}

export interface FindingsTablePreferencesProviderProps {
  children: ReactNode;
  userId?: string | null;
  initialPreferences?: TablePreferences;
}

export function FindingsTablePreferencesProvider({
  children,
  userId,
  initialPreferences,
}: FindingsTablePreferencesProviderProps) {
  const [preferences, setPreferences] = useState<TablePreferences>(() => {
    if (initialPreferences) {
      return {
        visibleColumns: {
          ...DEFAULT_VISIBLE_COLUMNS,
          ...initialPreferences.visibleColumns,
          severity: true,
          status: true,
        },
        density: initialPreferences.density ?? DEFAULT_DENSITY,
      };
    }
    return loadStoredPreferences(userId);
  });

  // Re-read when userId changes
  useEffect(() => {
    if (!initialPreferences) {
      setPreferences(loadStoredPreferences(userId));
    }
  }, [userId, initialPreferences]);

  const toggleColumn = (key: ColumnKey) => {
    if (key === "severity" || key === "status") {
      // Required columns cannot be hidden
      return;
    }
    setPreferences((prev) => {
      const next: TablePreferences = {
        ...prev,
        visibleColumns: {
          ...prev.visibleColumns,
          [key]: !prev.visibleColumns[key],
          severity: true,
          status: true,
        },
      };
      saveStoredPreferences(next, userId);
      return next;
    });
  };

  const setDensity = (density: DensityLevel) => {
    setPreferences((prev) => {
      const next: TablePreferences = {
        ...prev,
        density,
      };
      saveStoredPreferences(next, userId);
      return next;
    });
  };

  const resetPreferences = () => {
    const next: TablePreferences = {
      visibleColumns: { ...DEFAULT_VISIBLE_COLUMNS },
      density: DEFAULT_DENSITY,
    };
    saveStoredPreferences(next, userId);
    setPreferences(next);
  };

  return (
    <FindingsTablePreferencesContext.Provider
      value={{
        preferences,
        toggleColumn,
        setDensity,
        resetPreferences,
      }}
    >
      {children}
    </FindingsTablePreferencesContext.Provider>
  );
}

export interface FindingsColumnsMenuProps {
  className?: string;
  triggerVariant?: "outline" | "default" | "secondary" | "ghost";
  triggerSize?: "default" | "sm" | "lg" | "icon";
}

export function FindingsColumnsMenu({
  className,
  triggerVariant = "outline",
  triggerSize = "sm",
}: FindingsColumnsMenuProps) {
  const { preferences, toggleColumn, setDensity, resetPreferences } =
    useFindingsTablePreferences();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize}
          className={`gap-2 min-h-[36px] ${className || ""}`}
          aria-label="Customize columns and density"
          data-testid="findings-columns-menu-trigger"
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span>Columns & View</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 p-2 shadow-xl z-50 bg-popover text-popover-foreground"
        data-testid="findings-columns-menu-content"
      >
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-2 py-1">
          Density
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preferences.density}
          onValueChange={(val) => setDensity(val as DensityLevel)}
          aria-label="Row density"
        >
          <DropdownMenuRadioItem
            value="comfortable"
            data-testid="density-comfortable"
            className="cursor-pointer"
          >
            Comfortable
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="compact"
            data-testid="density-compact"
            className="cursor-pointer"
          >
            Compact
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-2 py-1 flex items-center justify-between">
          <span>Columns</span>
          <span className="text-[10px] font-normal lowercase text-muted-foreground">
            required cannot be hidden
          </span>
        </DropdownMenuLabel>
        <DropdownMenuGroup aria-label="Toggle visible columns">
          {COLUMNS_CONFIG.map((col) => {
            const isChecked = preferences.visibleColumns[col.key] ?? true;
            const isRequired = col.required === true;
            return (
              <DropdownMenuCheckboxItem
                key={col.key}
                checked={isChecked}
                disabled={isRequired}
                onCheckedChange={() => toggleColumn(col.key)}
                data-testid={`column-toggle-${col.key}`}
                className="cursor-pointer"
                onSelect={(e) => {
                  if (isRequired) {
                    e.preventDefault();
                    return;
                  }
                  // Prevent Radix from closing the menu on item toggle so user can toggle multiple columns
                  e.preventDefault();
                  toggleColumn(col.key);
                }}
              >
                <span>{col.label}</span>
                {isRequired && (
                  <span className="ml-auto text-[10px] uppercase font-mono text-muted-foreground/80 pl-2">
                    Required
                  </span>
                )}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={resetPreferences}
          data-testid="reset-columns-density"
          className="cursor-pointer text-xs text-muted-foreground hover:text-foreground flex items-center gap-2"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>Reset to defaults</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default FindingsColumnsMenu;
