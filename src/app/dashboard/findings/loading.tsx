import { Skeleton } from "@/components/ui/skeleton";

/**
 * Findings skeleton (#560).
 *
 * `findings/page.tsx` is `export const dynamic = "force-dynamic"` and runs three
 * sequential `count()` queries plus a `findMany` with a nested include, so this
 * wait happens on *every* visit rather than only on a cold one.
 *
 * `min-h-[520px]` on the list matches the `CardContent` in `findings-client.tsx`
 * so the page does not resize underneath the reader when the rows arrive.
 */
export default function FindingsLoading() {
  return (
    <div className="w-full space-y-8" aria-busy="true" aria-label="Loading security findings">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="glass-card rounded-xl p-6">
            <Skeleton className="mb-4 h-8 w-8 rounded-lg" />
            <Skeleton className="mb-2 h-8 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="glass-card rounded-xl">
        <div className="flex items-center justify-between p-6">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
        <div className="min-h-[520px] space-y-4 px-6 pb-6">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
