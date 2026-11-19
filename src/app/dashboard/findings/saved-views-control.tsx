"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Bookmark, Trash2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  createSavedView,
  deleteSavedView,
  type SavedViewDto,
  type SavedViewFilters,
} from "@/lib/actions/saved-views";

export interface SavedViewsControlProps {
  initialViews?: SavedViewDto[];
  currentFilters: SavedViewFilters;
}

export default function SavedViewsControl({
  initialViews = [],
  currentFilters,
}: SavedViewsControlProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [views, setViews] = useState<SavedViewDto[]>(initialViews);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sync if initialViews updates from server
  const [prevInitialViews, setPrevInitialViews] = useState(initialViews);
  if (initialViews !== prevInitialViews) {
    setPrevInitialViews(initialViews);
    setViews(initialViews);
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownOpen]);

  const applyView = (filters: SavedViewFilters) => {
    const params = new URLSearchParams();

    if (filters.severity && filters.severity.length > 0) {
      for (const s of filters.severity) params.append("severity", s);
    }
    if (filters.type && filters.type.length > 0) {
      for (const t of filters.type) params.append("type", t);
    }
    if (filters.status && filters.status.length > 0) {
      for (const st of filters.status) params.append("status", st);
    }
    if (filters.repositoryId) {
      params.set("repo", filters.repositoryId);
    }
    if (filters.search) {
      params.set("q", filters.search);
    }
    if (filters.from) {
      params.set("from", filters.from);
    }
    if (filters.to) {
      params.set("to", filters.to);
    }
    if (filters.sort && filters.sort !== "newest") {
      params.set("sort", filters.sort);
    }

    setDropdownOpen(false);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const handleSave = async () => {
    const trimmed = viewName.trim();
    if (!trimmed) {
      setError("Please provide a name for this view.");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const saved = await createSavedView({
        name: trimmed,
        filters: currentFilters,
      });

      setViews((prev) => {
        const withoutOld = prev.filter((v) => v.name.toLowerCase() !== trimmed.toLowerCase());
        return [saved, ...withoutOld];
      });

      setViewName("");
      setDialogOpen(false);
    } catch (err: any) {
      setError(err?.message || "Failed to save view");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSavedView(id);
      setViews((prev) => prev.filter((v) => v.id !== id));
    } catch (err: any) {
      console.error("Failed to delete saved view:", err);
    }
  };

  return (
    <div className="relative flex items-center gap-2" ref={dropdownRef}>
      {/* Dropdown toggle */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setDropdownOpen((prev) => !prev)}
        className="gap-1.5 font-mono text-xs border-white/10 hover:border-primary/40 bg-white/5"
        aria-label="Saved views"
        aria-expanded={dropdownOpen}
      >
        <Bookmark className="h-3.5 w-3.5 text-primary" />
        <span>Saved views</span>
        {views.length > 0 && (
          <Badge
            variant="secondary"
            className="ml-1 h-4 px-1.5 text-[10px] bg-primary/20 text-primary"
          >
            {views.length}
          </Badge>
        )}
      </Button>

      {/* Save view button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setViewName("");
          setDialogOpen(true);
        }}
        className="gap-1.5 font-mono text-xs border-white/10 hover:border-primary/40 bg-white/5"
        aria-label="Save current view"
      >
        <Plus className="h-3.5 w-3.5 text-primary" />
        <span>Save view</span>
      </Button>

      {/* Dropdown Menu */}
      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-2 w-[280px] z-50 rounded-xl border border-white/15 bg-black/90 p-2 shadow-2xl backdrop-blur-xl animate-in fade-in-50 zoom-in-95">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Saved Filter Views
          </div>
          <div className="my-1 border-t border-white/10" />

          {views.length === 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">
              No saved views yet. Apply desired filters and click &quot;Save view&quot;.
            </div>
          ) : (
            <div className="max-h-[240px] overflow-y-auto space-y-0.5 p-1">
              {views.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between px-2 py-1.5 hover:bg-white/5 rounded-md text-xs group transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => applyView(v.filters)}
                    className="flex-1 text-left truncate font-medium hover:text-primary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
                    title={`Apply filter "${v.name}"`}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(v.id);
                    }}
                    className="text-muted-foreground hover:text-red-400 opacity-60 group-hover:opacity-100 focus:opacity-100 p-1 rounded transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                    title={`Delete "${v.name}"`}
                    aria-label={`Delete saved view ${v.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Save View Modal Dialog */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="relative w-full max-w-[425px] rounded-xl border border-white/15 bg-black/95 p-6 shadow-2xl space-y-4">
            <button
              type="button"
              onClick={() => setDialogOpen(false)}
              className="absolute right-4 top-4 text-muted-foreground hover:text-foreground p-1"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <div>
              <h3 className="text-base font-bold font-headline">Save Current View</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Name this filter set to reload or apply it anytime. Saved views are private to your
                account.
              </p>
            </div>
            <div className="space-y-2">
              <Input
                placeholder="e.g. Open HIGH findings in repo X"
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                maxLength={80}
                aria-label="View name"
                className="text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSave();
                  }
                }}
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={isSaving || !viewName.trim()} onClick={handleSave}>
                {isSaving ? "Saving…" : "Save view"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
