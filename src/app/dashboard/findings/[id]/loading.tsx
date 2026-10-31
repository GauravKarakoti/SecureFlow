import { Skeleton } from "@/components/ui/skeleton";

/**
 * Finding detail skeleton (#1468).
 *
 * `page.tsx` is `force-dynamic` and waits on a `findFirst` with a three-level
 * include (scan result, pull request, repository) before anything renders, so
 * this shows on every navigation from the findings list.
 *
 * The layout mirrors the page: back/remediation links, the overview card header,
 * then the explanation column next to the source snippet.
 */
export default function FindingDetailLoading() {
  return (
    <div
      className="container mx-auto max-w-5xl space-y-6 px-4 py-8"
      aria-busy="true"
      aria-label="Loading finding details"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      <div className="glass-card rounded-xl">
        <div className="space-y-3 border-b border-white/5 p-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>

        <div className="space-y-6 p-6">
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <div className="space-y-6">
              <div className="space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
              <div className="space-y-3">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            </div>

            <div className="space-y-3">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-56 w-full rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
