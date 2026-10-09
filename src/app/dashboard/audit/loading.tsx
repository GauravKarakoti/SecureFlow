import { Skeleton } from "@/components/ui/skeleton";

/**
 * Audit log skeleton (#560).
 *
 * `audit/page.tsx` awaits a four-way `Promise.all` — the paginated log query,
 * the filter facets, and two `count()` calls — before rendering. The two summary
 * tiles and the table are mirrored here so the header does not shift when the
 * counts arrive.
 */
export default function AuditLoading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading audit logs">
      <div className="space-y-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="flex items-center gap-4 rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4"
          >
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card rounded-xl p-6">
        <div className="mb-6 flex flex-wrap gap-3">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-36" />
        </div>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
