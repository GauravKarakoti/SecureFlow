import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard overview skeleton (#560).
 *
 * `src/app/dashboard/page.tsx` is an async server component that awaits several
 * Prisma aggregates before it can render anything. Without a `loading.tsx`
 * Next.js keeps the *previous* route on screen until every one of them resolves,
 * so clicking "Dashboard" appears to do nothing at all.
 *
 * The shape mirrors the real page — a header block, a row of stat tiles, then a
 * wide panel — so the layout does not jump when the data lands.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading dashboard">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="glass-card rounded-xl p-6">
            <div className="flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-6 w-16" />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card rounded-xl p-6">
        <Skeleton className="mb-6 h-5 w-40" />
        <div className="space-y-4">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
