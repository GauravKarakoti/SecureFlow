"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
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
import {
  DEFAULT_SORT,
  FINDING_SORTS,
  FINDING_STATUSES,
  VALID_FINDING_TYPES,
  parseDateParam,
  parseSort,
  type FindingStatus,
} from "@/lib/findings/query";
import { parseStoredSeverity } from "@/lib/severity";
import type { FindingFilterOptions } from "@/lib/actions/findings";
import SavedViewsControl from "./saved-views-control";
import type { SavedViewDto, SavedViewFilters } from "@/lib/actions/saved-views";

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
  DISMISSED: "Dismissed",
  RESOLVED: "Resolved",
  FALSE_POSITIVE: "False positive (legacy)",
  IGNORED: "Ignored (legacy)",
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
  /** Saved views for the current user (#1786). */
  savedViews?: SavedViewDto[];
}

export default function FindingsToolbar({
  options,
  total,
  bulkMode,
  onToggleBulkMode,
  canBulkSelect,
  savedViews = [],
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
  //
  // The URL holds the trimmed term, so when the change is only the debounce below
  // applying this draft, the draft is kept as typed. Replacing it dropped a trailing
  // space: pause after "api " and the box snapped back to "api" before the next word.
  if (currentSearch !== syncedSearch) {
    setSyncedSearch(currentSearch);
    if (searchDraft.trim() !== currentSearch) setSearchDraft(currentSearch);
  }

  const apply = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      // Any filter change invalidates the current offset: staying on page 4
      // after narrowing to two results shows an empty list.
      params.delete("page");

      const query = params.toString();
      const navigate = router.push ?? router.replace;
      startTransition(() => {
        navigate.call(router, query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const setSingle = useCallback(
    (key: string, value: string) => {
      apply((params) => {
        if (!value || value === ANY) params.delete(key);
        else params.set(key, value);
      });
    },
    [apply],
  );

  // Debounced so a search term does not push one history entry per keystroke.
  useEffect(() => {
    if (searchDraft.trim() === currentSearch) return;

    const timer = setTimeout(() => {
      apply((params) => {
        const trimmed = searchDraft.trim();
        if (trimmed) params.set("q", trimmed);
        else params.delete("q");
      });
    }, 350);

    return () => clearTimeout(timer);
  }, [searchDraft, currentSearch, apply]);

  // Validate and restore severity from URL, ignoring invalid values and falling back to default (ANY)
  const rawSeverity = searchParams.get("severity");
  const parsedSeverity = rawSeverity ? parseStoredSeverity(rawSeverity) : null;
  const activeSeverity = parsedSeverity ?? ANY;

  // Validate and restore status from URL, ignoring invalid values and falling back to default (ANY)
  const rawStatus = searchParams.get("status")?.trim().toUpperCase();
  const activeStatus =
    rawStatus && (FINDING_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as FindingStatus)
      : ANY;

  // Validate and restore expiring filter from URL
  const rawExpiring = searchParams.get("expiring")?.trim().toLowerCase();
  const activeExpiring =
    rawExpiring === "14d" || rawExpiring === "14" || rawExpiring === "true" ? "14d" : ANY;

  // Validate and restore sort from URL, ignoring invalid values and falling back to default ("newest")
  const activeSort = parseSort(searchParams.get("sort"));

  // Validate and restore type from URL, ignoring invalid values and falling back to default (ANY)
  const rawType = searchParams.get("type")?.trim().toUpperCase();
  const validTypes = new Set<string>([...VALID_FINDING_TYPES, ...options.types]);
  const activeType = rawType && validTypes.has(rawType) ? rawType : ANY;

  // Validate and restore repo from URL, ignoring invalid values and falling back to default (ANY)
  const rawRepo = searchParams.get("repo")?.trim();
  const activeRepo =
    rawRepo && options.repositories.some((repo) => repo.id === rawRepo) ? rawRepo : ANY;

  // Validate and restore date range from URL, ignoring invalid values and falling back to default ("")
  const activeFrom = parseDateParam(searchParams.get("from")) ?? "";
  const activeTo = parseDateParam(searchParams.get("to")) ?? "";

  // Ensure select dropdown options include the active choice even if options list is empty or partial
  const displaySeverities = useMemo(() => {
    const set = new Set(options.severities);
    if (parsedSeverity) {
      set.add(parsedSeverity);
    }
    return Array.from(set);
  }, [options.severities, parsedSeverity]);

  const displayTypes = useMemo(() => {
    const set = new Set(options.types);
    if (activeType !== ANY) {
      set.add(activeType);
    }
    return Array.from(set);
  }, [options.types, activeType]);

  const activeFilters: SavedViewFilters = {
    severity: activeSeverity !== ANY ? [activeSeverity] : [],
    type: activeType !== ANY ? [activeType] : [],
    status: activeStatus !== ANY ? [activeStatus] : [],
    repositoryId: activeRepo !== ANY ? activeRepo : undefined,
    search: searchDraft.trim() || undefined,
    from: activeFrom || undefined,
    to: activeTo || undefined,
    sort: activeSort !== DEFAULT_SORT ? activeSort : undefined,
    expiring: activeExpiring !== ANY ? activeExpiring : undefined,
  };

  const hasActiveSeverity = activeSeverity !== ANY;
  const hasActiveType = activeType !== ANY;
  const hasActiveStatus = activeStatus !== ANY;
  const hasActiveRepo = activeRepo !== ANY;
  const hasActiveSearch = Boolean(searchDraft.trim());
  const hasActiveFrom = Boolean(activeFrom);
  const hasActiveTo = Boolean(activeTo);
  const hasActiveExpiring = activeExpiring !== ANY;

  const activeCount = [
    hasActiveSeverity,
    hasActiveType,
    hasActiveStatus,
    hasActiveRepo,
    hasActiveSearch,
    hasActiveFrom,
    hasActiveTo,
    hasActiveExpiring,
  ].filter(Boolean).length;

  const hasFilterParams =
    activeCount > 0 ||
    ["severity", "type", "status", "repo", "q", "from", "to", "expiring"].some((key) =>
      searchParams.has(key),
    );

  return (
    <div className="glass-card rounded-xl p-4" data-testid="findings-toolbar">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 w-full sm:min-w-[220px] sm:flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search type, file path, explanation or remediation"
            aria-label="Search findings"
            className="pl-9 min-h-[44px]"
          />
        </div>

        <Select value={activeSeverity} onValueChange={(value) => setSingle("severity", value)}>
          <SelectTrigger
            className="w-full sm:w-[150px] min-h-[44px]"
            aria-label="Filter by severity"
            data-testid="severity-filter"
          >
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any severity</SelectItem>
            {displaySeverities.map((severity) => (
              <SelectItem key={severity} value={severity}>
                {severity}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={activeType} onValueChange={(value) => setSingle("type", value)}>
          <SelectTrigger className="w-full sm:w-[170px] min-h-[44px]" aria-label="Filter by type">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any type</SelectItem>
            {displayTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={activeStatus} onValueChange={(value) => setSingle("status", value)}>
          <SelectTrigger
            className="w-full sm:w-[160px] min-h-[44px]"
            aria-label="Filter by triage status"
          >
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

        <Select value={activeExpiring} onValueChange={(value) => setSingle("expiring", value)}>
          <SelectTrigger
            className="w-full sm:w-[180px] min-h-[44px]"
            aria-label="Filter by expiry"
            data-testid="filter-expiry-select"
          >
            <SelectValue placeholder="Expiry" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All expiry</SelectItem>
            <SelectItem value="14d">Expiring in 14 days</SelectItem>
          </SelectContent>
        </Select>

        {options.repositories.length > 1 && (
          <Select value={activeRepo} onValueChange={(value) => setSingle("repo", value)}>
            <SelectTrigger
              className="w-full sm:w-[200px] min-h-[44px]"
              aria-label="Filter by repository"
            >
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
          <SelectTrigger className="w-full sm:w-[180px] min-h-[44px]" aria-label="Sort findings">
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

        <div className="w-full sm:w-auto flex items-center justify-between sm:justify-start gap-1.5 bg-white/5 border border-white/10 rounded-md px-3 py-1 min-h-[44px] focus-within:ring-2 focus-within:ring-ring focus-within:border-primary/50">
          <span className="text-[11px] font-mono text-muted-foreground uppercase">From:</span>
          <Input
            type="date"
            value={activeFrom}
            onChange={(e) => setSingle("from", e.target.value)}
            aria-label="Filter from date"
            className="w-full sm:w-[125px] h-8 text-xs font-mono p-1 border-0 bg-transparent focus-visible:ring-0"
          />
        </div>

        <div className="w-full sm:w-auto flex items-center justify-between sm:justify-start gap-1.5 bg-white/5 border border-white/10 rounded-md px-3 py-1 min-h-[44px] focus-within:ring-2 focus-within:ring-ring focus-within:border-primary/50">
          <span className="text-[11px] font-mono text-muted-foreground uppercase">To:</span>
          <Input
            type="date"
            value={activeTo}
            onChange={(e) => setSingle("to", e.target.value)}
            aria-label="Filter to date"
            className="w-full sm:w-[125px] h-8 text-xs font-mono p-1 border-0 bg-transparent focus-visible:ring-0"
          />
        </div>

        <SavedViewsControl initialViews={savedViews} currentFilters={activeFilters} />

        {onToggleBulkMode && canBulkSelect && (
          <>
            <Button
              variant={bulkMode ? "secondary" : "outline"}
              size="sm"
              onClick={onToggleBulkMode}
              className="gap-2 min-h-[44px]"
            >
              <ListChecks className="h-4 w-4" aria-hidden="true" />
              {bulkMode ? "Cancel bulk select" : "Bulk select"}
            </Button>
            {bulkMode && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 min-h-[44px]"
              >
                Rollback Patches
              </Button>
            )}
          </>
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

        {hasFilterParams && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label="Clear filters"
            onClick={() => {
              setSearchDraft("");
              apply((params) => {
                for (const key of ["severity", "type", "status", "repo", "q", "from", "to"]) {
                  params.delete(key);
                }
              });
            }}
          >
            <X className="mr-1 h-3 w-3" aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
