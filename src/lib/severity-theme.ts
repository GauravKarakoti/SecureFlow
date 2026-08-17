/**
 * Heist-themed presentation layer for severity levels.
 *
 * NOTE: This is a DISPLAY-ONLY mapping. The underlying severity values
 * (CRITICAL/HIGH/MEDIUM/LOW/NONE) are intentionally left untouched since
 * they're the contract used by the DB, the LLM prompt, policy gating in
 * armor/iq.ts, and the GitHub webhook alerts. Only the findings dashboard
 * should render through this mapping.
 *
 * The canonical `Severity` type and the parsing rules now live in
 * `@/lib/severity`; this module re-exports the type so existing importers keep
 * working. That module is likewise free of server-only imports, so this file is
 * still safe to import from client components like `findings-client.tsx`
 * without pulling server-side code into the browser bundle.
 */

import { normalizeSeverity, parseSeverity, type Severity } from './severity';

export type { Severity };

export const SEVERITY_THEME: Record<Severity, { label: string; badgeClass: string }> = {
  CRITICAL: { label: 'Interpol Breach', badgeClass: 'bg-red-500' },
  HIGH: { label: 'Hostage Crisis', badgeClass: 'bg-orange-500' },
  MEDIUM: { label: 'Camera Glitch', badgeClass: 'bg-yellow-500 text-black' },
  LOW: { label: 'Loose Screws', badgeClass: 'bg-slate-500' },
  NONE: { label: 'All Clear', badgeClass: 'bg-emerald-500' },
};

/**
 * Resolve the themed label and badge classes for a severity.
 *
 * Values are normalized first, so a row stored as `"critical"` or `" High "`
 * renders as "Interpol Breach" / "Hostage Crisis" instead of falling through to
 * the neutral grey badge with the raw string echoed back at the user.
 *
 * A value that genuinely cannot be interpreted still echoes back — showing the
 * user what the database actually holds is more useful than pretending it is
 * MEDIUM — but it does so through a stringified, trimmed form so a non-string
 * value cannot render as `[object Object]`.
 */
export function getSeverityTheme(severity: unknown): { label: string; badgeClass: string } {
  const parsed = parseSeverity(severity);
  if (parsed !== null) return SEVERITY_THEME[parsed];

  const raw = typeof severity === 'string' ? severity.trim() : '';
  return {
    label: raw || SEVERITY_THEME[normalizeSeverity(severity, 'NONE')].label,
    badgeClass: 'bg-slate-500',
  };
}
