"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Pagination for the findings list (#561).
 *
 * The page number lives in the URL alongside the filters, so "page 3 of the
 * CRITICAL secrets in api-gateway" is a link you can send someone.
 */

export interface FindingsPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export default function FindingsPagination({
  page,
  pageSize,
  total,
  totalPages,
}: FindingsPaginationProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const goTo = useCallback(
    (nextPage: number) => {
      const params = new URLSearchParams(searchParams.toString());
      // Page 1 is the default, so it is left out of the URL entirely — a clean
      // view should have a clean address.
      if (nextPage <= 1) params.delete("page");
      else params.set("page", String(nextPage));

      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams]
  );

  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav
      aria-label="Findings pagination"
      data-testid="findings-pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-foreground/10 px-6 py-4"
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing <span className="font-medium text-foreground">{first.toLocaleString()}</span>–
        <span className="font-medium text-foreground">{last.toLocaleString()}</span> of{" "}
        <span className="font-medium text-foreground">{total.toLocaleString()}</span>
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || isPending}
          onClick={() => goTo(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          Previous
        </Button>

        <span className="px-2 text-xs text-muted-foreground">
          Page {page.toLocaleString()} of {totalPages.toLocaleString()}
        </span>

        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages || isPending}
          onClick={() => goTo(page + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
