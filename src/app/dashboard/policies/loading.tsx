import { Skeleton } from "@/components/ui/skeleton";

/**
 * Policies skeleton (#1579).
 *
 * `policies/page.tsx` is an async server component that runs two Prisma
 * `findMany` queries plus `ArmorIQService.compileToArmorIQPolicy` before
 * rendering, so this mirrors the page's layout — header, compiled-policy card,
 * and the rule-card grid — to avoid a layout jump when the data arrives.
 */
export default function PoliciesLoading() {
  return (
    <div className="w-full space-y-8" aria-busy="true" aria-label="Loading policies">
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="glass-card rounded-xl border border-white/10 p-6">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="mb-4 h-4 w-full max-w-xl" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="glass-card rounded-xl p-6">
            <div className="mb-4 flex items-center justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-6 w-11 rounded-full" />
            </div>
            <Skeleton className="mb-2 h-4 w-full" />
            <Skeleton className="mb-4 h-4 w-3/4" />
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
