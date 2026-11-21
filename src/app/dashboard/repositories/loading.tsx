import { Skeleton } from "@/components/ui/skeleton";

export default function RepositoriesLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64 bg-zinc-800" />
        <Skeleton className="h-4 w-96 bg-zinc-800/60" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-lg bg-zinc-900 border border-white/5" />
        ))}
      </div>

      <div className="flex justify-between items-center gap-4">
        <Skeleton className="h-10 w-72 bg-zinc-800" />
        <div className="flex gap-2">
          <Skeleton className="h-10 w-36 bg-zinc-800" />
          <Skeleton className="h-10 w-36 bg-zinc-800" />
        </div>
      </div>

      <Skeleton className="h-96 rounded-md bg-zinc-900 border border-white/5" />
    </div>
  );
}
