import { Skeleton } from "@/components/ui/skeleton";

/**
 * Remediation skeleton (#1468).
 *
 * Matches the pre-generation state of `page.tsx`: the heading row followed by a
 * single card holding the prompt text and the "Generate Remediation Patch"
 * button, so the page does not jump when the client component hydrates.
 */
export default function RemediationLoading() {
  return (
    <div
      className="container mx-auto max-w-4xl space-y-6 px-4 py-8"
      aria-busy="true"
      aria-label="Loading remediation"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-6 rounded-full" />
        <Skeleton className="h-8 w-48" />
      </div>

      <div className="glass-card rounded-xl">
        <div className="flex flex-col items-center space-y-4 px-6 py-12">
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-2/3 max-w-sm" />
          <Skeleton className="h-11 w-60 rounded-md" />
        </div>
      </div>
    </div>
  );
}
