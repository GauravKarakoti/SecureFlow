import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function PoliciesLoading() {
  return (
    <div
      className="space-y-8 animate-in fade-in duration-500"
      data-testid="policies-loading"
      role="status"
      aria-label="Loading security policies and programmatic rules"
    >
      {/* Header section skeleton */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
      </div>

      {/* Programmatic Rule Set Card Skeleton */}
      <Card
        className="glass-card bg-primary/5 border-primary/20"
        data-testid="policies-summary-skeleton"
      >
        <CardHeader className="pb-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-md" />
              <Skeleton className="h-5 w-52" />
            </div>
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-3 w-3/4 max-w-xl" />
        </CardHeader>
        <CardContent>
          <div className="p-4 bg-black/50 rounded-lg border border-white/10 space-y-2.5 font-mono">
            <div className="flex items-center justify-between pb-2 border-b border-white/5">
              <Skeleton className="h-3 w-36" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </CardContent>
      </Card>

      {/* Policy Rule Cards Grid Skeleton */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        data-testid="policies-grid-skeleton"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Card
            key={i}
            className="glass-card relative overflow-hidden flex flex-col justify-between border-white/10"
            data-testid={`policy-card-skeleton-${i}`}
          >
            <CardHeader className="pb-3 space-y-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="space-y-2">
                <Skeleton className="h-3 w-28" />
                <div className="flex flex-wrap gap-1.5">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
              </div>
              <div className="p-2.5 rounded-md bg-white/5 space-y-1.5">
                <Skeleton className="h-2.5 w-full" />
                <Skeleton className="h-2.5 w-5/6" />
              </div>
              <div className="pt-2 border-t border-white/5 flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-6 w-11 rounded-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
