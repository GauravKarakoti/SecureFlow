"use client";

import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Format a date into relative time text (e.g., "just now", "5 minutes ago", "2 days ago").
 *
 * Thresholds:
 * - < 5s: "just now"
 * - < 60s: "{s} seconds ago"
 * - 1m to < 2m: "1 minute ago"
 * - 2m to < 60m: "{m} minutes ago"
 * - 1h to < 2h: "1 hour ago"
 * - 2h to < 24h: "{h} hours ago"
 * - 1d to < 2d: "1 day ago"
 * - 2d to < 30d: "{d} days ago"
 * - 1mo to < 2mo: "1 month ago"
 * - 2mo to < 12mo: "{mo} months ago"
 * - 1y to < 2y: "1 year ago"
 * - >= 2y: "{y} years ago"
 */
export function formatRelativeTime(
  date: Date | string | number,
  now: Date | number = Date.now(),
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "Invalid date";

  const nowMs = typeof now === "number" ? now : now.getTime();
  const diffMs = nowMs - d.getTime();

  // Future dates (clock skew or scheduled items)
  if (diffMs < 0) {
    const futureSec = Math.floor(Math.abs(diffMs) / 1000);
    if (futureSec < 5) return "just now";
    if (futureSec < 60) return `in ${futureSec} seconds`;
    const futureMin = Math.floor(futureSec / 60);
    if (futureMin === 1) return "in 1 minute";
    if (futureMin < 60) return `in ${futureMin} minutes`;
    const futureHours = Math.floor(futureMin / 60);
    if (futureHours === 1) return "in 1 hour";
    if (futureHours < 24) return `in ${futureHours} hours`;
    const futureDays = Math.floor(futureHours / 24);
    if (futureDays === 1) return "in 1 day";
    return `in ${futureDays} days`;
  }

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec} seconds ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin === 1) return "1 minute ago";
  if (diffMin < 60) return `${diffMin} minutes ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 day ago";
  if (diffDays < 30) return `${diffDays} days ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths === 1) return "1 month ago";
  if (diffMonths < 12) return `${diffMonths} months ago`;

  const diffYears = Math.floor(diffDays / 365);
  if (diffYears === 1) return "1 year ago";
  return `${diffYears} years ago`;
}

/**
 * Convenience alias for formatRelativeTime to match the proposal contract.
 */
export function formatTimestamp(date: Date | string | number, now?: Date | number): string {
  return formatRelativeTime(date, now);
}

/**
 * Format date in full date and time according to user's local timezone.
 */
export function formatLocalTime(date: Date | string | number, locale?: string): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(d);
}

/**
 * Format date in UTC with explicit "UTC" suffix.
 */
export function formatUtcTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "Invalid date";
  return (
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(d) + " UTC"
  );
}

export interface TimeAgoProps {
  date: Date | string | number;
  className?: string;
  updateIntervalMs?: number;
  showTooltip?: boolean;
}

/**
 * Shared <TimeAgo> component.
 *
 * Renders relative text ("5 minutes ago") that updates without a full reload,
 * and shows full local time and UTC time in a tooltip on hover.
 *
 * Designed to be completely hydration-safe:
 * - Uses `suppressHydrationWarning` on the `<time>` tag.
 * - Client-only dynamic re-renders via `mounted` state.
 */
const emptySubscribe = () => () => {};

function useIsMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

export function TimeAgo({ date, className, updateIntervalMs, showTooltip = true }: TimeAgoProps) {
  const dateObj = useMemo(() => {
    return date instanceof Date ? date : new Date(date);
  }, [date]);

  const isValid = !Number.isNaN(dateObj.getTime());

  const mounted = useIsMounted();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Adaptive update interval if not explicitly provided
    let intervalMs = updateIntervalMs;
    if (!intervalMs) {
      const diff = Math.abs(Date.now() - dateObj.getTime());
      intervalMs = diff < 60_000 ? 5_000 : diff < 3_600_000 ? 30_000 : 60_000;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => clearInterval(timer);
  }, [dateObj, updateIntervalMs]);

  if (!isValid) {
    return <span className={className}>Invalid date</span>;
  }

  const relativeText = formatRelativeTime(dateObj, now);
  const localFormatted = mounted ? formatLocalTime(dateObj) : formatUtcTime(dateObj);
  const utcFormatted = formatUtcTime(dateObj);
  const tooltipTitle = `Local: ${localFormatted}\nUTC: ${utcFormatted}`;

  const timeElement = (
    <time
      dateTime={dateObj.toISOString()}
      suppressHydrationWarning
      title={mounted ? tooltipTitle : undefined}
      className={cn(
        "cursor-default underline decoration-dotted decoration-muted-foreground/30 underline-offset-2",
        className,
      )}
    >
      {relativeText}
    </time>
  );

  if (!showTooltip) {
    return timeElement;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{timeElement}</TooltipTrigger>
        <TooltipContent className="text-xs space-y-1 z-50">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-muted-foreground">Local:</span>
            <span>{localFormatted}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-muted-foreground">UTC:</span>
            <span className="font-mono text-[11px]">{utcFormatted}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default TimeAgo;
