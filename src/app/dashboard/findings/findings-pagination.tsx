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

/**
 * Extra styling for a disabled page button.
 *
 * The base `Button` already sets `disabled:opacity-50`, which on the `outline`
 * variant leaves a control that still reads as clickable — the border and the
 * label stay crisp and only the whole thing fades slightly. These flatten the
 * affordances themselves: the border and text drop to muted values and the
 * shadow goes, so the button reads as inert rather than merely dimmed.
 */
const DISABLED_BUTTON_CLASSES =
  "disabled:opacity-40 disabled:border-foreground/10 disabled:bg-transparent " +
  "disabled:text-muted-foreground disabled:shadow-none";

/**
 * Wrapper that gives a disabled button a `not-allowed` cursor.
 *
 * `Button` sets `disabled:pointer-events-none`, which is what stops a disabled
 * control firing its handler — but it also stops the element receiving hover at
 * all, so a `cursor` rule on the button itself never applies and the pointer
 * stays a plain arrow. The cursor has to live on an ancestor that still accepts
 * pointer events, which is what this span is for.
 *
 * `aria-hidden` is deliberately not set: the span is presentational, and the
 * button inside keeps its own label and `disabled` state for assistive tech.
 */
function PageButtonSlot({
  disabled,
  children,
}: {
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={disabled ? "inline-flex cursor-not-allowed" : "inline-flex"}>
      {children}
    </span>
  );
}

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

  // Both buttons are also disabled while a navigation is in flight, so a double
  // click cannot queue two page changes.
  const previousDisabled = page <= 1 || isPending;
  const nextDisabled = page >= totalPages || isPending;

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
        <PageButtonSlot disabled={previousDisabled}>
          <Button
            variant="outline"
            size="sm"
            className={DISABLED_BUTTON_CLASSES}
            disabled={previousDisabled}
            onClick={() => goTo(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
            Previous
          </Button>
        </PageButtonSlot>

        <span className="px-2 text-xs text-muted-foreground">
          Page {page.toLocaleString()} of {totalPages.toLocaleString()}
        </span>

        <PageButtonSlot disabled={nextDisabled}>
          <Button
            variant="outline"
            size="sm"
            className={DISABLED_BUTTON_CLASSES}
            disabled={nextDisabled}
            onClick={() => goTo(page + 1)}
            aria-label="Next page"
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
          </Button>
        </PageButtonSlot>
      </div>
    </nav>
  );
}
