"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal, X, ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FINDING_SORTS, FINDING_STATUSES } from "@/lib/findings/query";
import type { FindingFilterOptions } from "@/lib/actions/findings";

/**
 * Filter and sort controls for the findings list (#561).
 *
 * State lives in the URL rather than in `useState`, so a filtered view is
 * bookmarkable, shareable and survives a reload — the thing you actually want
 * when you are sending a colleague "here are the four CRITICAL secrets in
 * api-gateway". `src/app/dashboard/findings/page.tsx` is a server component that
 * reads `searchParams`, so writing the URL is also what refetches the data.
 */

/** Sentinel for "no filter" in a Select, which cannot hold an empty string value. */
const ANY = "__any__";

const SORT_LABELS: Record<string, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  severity: "Most severe first",
  file: "By file path",
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  RESOLVED: "Resolved",
  FALSE_POSITIVE: "False positive",
  IGNORED: "Ignored",
};

export interface FindingsToolbarProps {
  options: FindingFilterOptions;
  total: number;
  /**
   * Bulk-select controls (#732). Optional so the toolbar renders unchanged
   * where bulk triage is not wired up (and so its existing tests still pass).
   */
  bulkMode?: boolean;
  onToggleBulkMode?: () => void;
  canBulkSelect?: boolean;
}

export default function FindingsToolbar({
  options,
  total,
  bulkMode,
  onToggleBulkMode,
  canBulkSelect,
}: FindingsToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentSearch = searchParams.get("q") ?? "";
  const [searchDraft, setSearchDraft] = useState(currentSearch);
  const [syncedSearch, setSyncedSearch] = useState(currentSearch);

  // Keep the box in step with the URL when the user navigates back or clicks
  // "Clear filters" — without this the input keeps a value that is no longer
  // being applied, which reads as a broken filter.
  //
  // Adjusted during render rather than in an effect: setting state from an
  // effect renders once with the stale value and then again with the fresh one,
  // which is both a visible flash and the cascading-render pattern the lint
  // rule flags. React re-runs this component immediately instead.
  if (currentSearch !== syncedSearch) {
    setSyncedSearch(currentSearch);
    setSearchDraft(currentSearch);
  }

  const apply = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      // Any filter change invalidates the current offset: staying on page 4
      // after narrowing to two results shows an empty list.
      params.delete("page");

      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams]
  );

  const setSingle = useCallback(
    (key: string, value: string) => {
      apply((params) => {
        if (!value || value === ANY) params.delete(key);
        else params.set(key, value);
      });
    },
    [apply]
  );

  // Debounced so a search term does not push one history entry per keystroke.
  useEffect(() => {
    if (searchDraft === currentSearch) return;

    const timer = setTimeout(() => {
      apply((params) => {
        const trimmed = searchDraft.trim();
        if (trimmed) params.set("q", trimmed);
        else params.delete("q");
      });
    }, 350);

    return () => clearTimeout(timer);
  }, [searchDraft, currentSearch, apply]);

  const activeSeverity = searchParams.get("severity") ?? ANY;
  const activeType = searchParams.get("type") ?? ANY;
  const activeStatus = searchParams.get("status") ?? ANY;
  const activeRepo = searchParams.get("repo") ?? ANY;
  const activeSort = searchParams.get("sort") ?? "newest";

  const activeCount = ["severity", "type", "status", "repo", "q"].filter((key) =>
    searchParams.has(key)
  ).length;

  return (
    <div className="glass-card rounded-xl p-4" data-testid="findings-toolbar">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search type, file path, explanation or remediation"
            aria-label="Search findings"
            className="pl-9"
          />
        </div>

        <Select value={activeSeverity} onValueChange={(value) => setSingle("severity", value)}>
          <SelectTrigger className="w-[150px]" aria-label="Filter by severity">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any severity</SelectItem>
            {options.severities.map((severity) => (
              <SelectItem key={severity} value={severity}>
                {severity}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={activeType} onValueChange={(value) => setSingle("type", value)}>
          <SelectTrigger className="w-[170px]" aria-label="Filter by type">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any type</SelectItem>
            {options.types.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={activeStatus} onValueChange={(value) => setSingle("status", value)}>
          <SelectTrigger className="w-[160px]" aria-label="Filter by triage status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {FINDING_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status] ?? status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {options.repositories.length > 1 && (
          <Select value={activeRepo} onValueChange={(value) => setSingle("repo", value)}>
            <SelectTrigger className="w-[200px]" aria-label="Filter by repository">
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All repositories</SelectItem>
              {options.repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={activeSort} onValueChange={(value) => setSingle("sort", value)}>
          <SelectTrigger className="w-[180px]" aria-label="Sort findings">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            {FINDING_SORTS.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {SORT_LABELS[sort] ?? sort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {onToggleBulkMode && canBulkSelect && (
          <Button
            variant={bulkMode ? "secondary" : "outline"}
            onClick={onToggleBulkMode}
            aria-pressed={bulkMode}
            className="gap-2"
          >
            <ListChecks className="h-4 w-4" aria-hidden="true" />
            {bulkMode ? "Cancel bulk select" : "Bulk select"}
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
          <span aria-live="polite">
            {isPending
              ? "Updating…"
              : `${total.toLocaleString()} ${total === 1 ? "finding" : "findings"} match`}
          </span>
          {activeCount > 0 && (
            <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
              {activeCount} {activeCount === 1 ? "filter" : "filters"}
            </Badge>
          )}
        </div>

        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() =>
              apply((params) => {
                for (const key of ["severity", "type", "status", "repo", "q"]) {
                  params.delete(key);
                }
              })
            }
          >
            <X className="mr-1 h-3 w-3" aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
