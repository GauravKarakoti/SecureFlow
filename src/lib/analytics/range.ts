/**
 * The time windows the analytics dashboard offers.
 *
 * Pure and dependency-free, so the client component can import the list for
 * its selector without pulling `scan-history.ts` (and its Prisma client) into
 * the browser bundle.
 */

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = 30;

/**
 * Read `?range=` into one of the offered windows.
 *
 * Anything else — absent, non-numeric, or a hand-edited `?range=100000` that
 * would otherwise build a 100,000-bucket chart and scan every row the user owns
 * — falls back to the default rather than erroring, the same way the findings
 * page treats a bad `?page=`.
 */
export function parseAnalyticsRange(value: string | string[] | undefined | null): AnalyticsRange {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return ANALYTICS_RANGES.find((range) => range === parsed) ?? DEFAULT_ANALYTICS_RANGE;
}
