"use client";

import Link from "next/link";
import { AlertOctagon, Home, LayoutDashboard, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared presentation for every failure surface in the app (#560).
 *
 * The App Router tree had no `error.tsx`, no `global-error.tsx` and no
 * `not-found.tsx`, so a thrown server component — an unreachable Postgres
 * during the `Promise.all` in `dashboard/audit/page.tsx`, say — fell through to
 * Next's built-in fallback: an unstyled page reading "Application error: a
 * server-side exception has occurred", a digest hash, and no way to retry short
 * of a manual reload. On a security dashboard that is a bad failure mode.
 *
 * One component backs all of them so the boundaries stay consistent and so the
 * redaction rule below lives in exactly one place.
 */

/**
 * Why the error message is never rendered.
 *
 * `scrubSensitiveData()` in `src/lib/middleware/error-handler.ts` exists because
 * a thrown Prisma error carries the connection string, the failing query and its
 * parameters in its message. Next.js already strips server error messages before
 * they cross to the client in production and replaces them with a `digest`, and
 * this component deliberately does not try to render one anyway: in development
 * the real message *is* present on the error object, and a component that prints
 * `error.message` when it happens to be there is one `NODE_ENV` mistake away
 * from putting a database URL on a public page.
 *
 * The digest is the correlation handle — it appears in the server log next to
 * the full stack.
 */
export interface ErrorStateProps {
  /** Short headline, e.g. "Signal lost". */
  title: string;
  /** One or two sentences describing what happened in plain language. */
  description: string;
  /** Next.js error digest, correlating this page with the server-side log entry. */
  digest?: string;
  /** Large status glyph — "404", "500". Rendered as decoration. */
  code?: string;
  /** Wired to the boundary's `reset()`. Omitted for 404, which cannot be retried. */
  onRetry?: () => void;
  /** Show a link to `/dashboard`. */
  showDashboardLink?: boolean;
  /** Show a link to `/`. */
  showHomeLink?: boolean;
  className?: string;
}

export function ErrorState({
  title,
  description,
  digest,
  code,
  onRetry,
  showDashboardLink = true,
  showHomeLink = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="error-state"
      className={cn(
        "flex min-h-[60vh] w-full flex-col items-center justify-center px-6 py-16 text-center",
        className
      )}
    >
      <div className="glass-card w-full max-w-lg rounded-2xl p-8 sm:p-10">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <AlertOctagon className="h-7 w-7" aria-hidden="true" />
        </div>

        {code ? (
          <div
            aria-hidden="true"
            className="font-headline mb-2 text-5xl font-extrabold tracking-tight text-gradient"
          >
            {code}
          </div>
        ) : null}

        <h1 className="font-headline text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>

        <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">{description}</p>

        {digest ? (
          <p className="mt-6 text-xs text-muted-foreground">
            Reference{" "}
            <code
              data-testid="error-digest"
              className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[11px] tracking-wider"
            >
              {digest}
            </code>
          </p>
        ) : null}

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {onRetry ? (
            <Button onClick={onRetry} className="w-full sm:w-auto">
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          ) : null}

          {showDashboardLink ? (
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <Link href="/dashboard">
                <LayoutDashboard className="mr-2 h-4 w-4" aria-hidden="true" />
                Back to dashboard
              </Link>
            </Button>
          ) : null}

          {showHomeLink ? (
            <Button asChild variant="ghost" className="w-full sm:w-auto">
              <Link href="/">
                <Home className="mr-2 h-4 w-4" aria-hidden="true" />
                Home
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ErrorState;
