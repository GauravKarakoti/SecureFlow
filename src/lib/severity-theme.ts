/**
 * Heist-themed presentation layer for severity levels.
 * NOTE: This is a DISPLAY-ONLY mapping. The underlying severity values
 * (CRITICAL/HIGH/MEDIUM/LOW/NONE) are intentionally left untouched since
 * they're the contract used by the DB, the LLM prompt, policy gating in
 * armor/iq.ts, and the GitHub webhook alerts. Only the findings dashboard
 * should render through this mapping.
 *
 * This file is deliberately kept free of any server-only imports (Groq,
 * Prisma, etc.) so it's safe to import from client components like
 * findings-client.tsx without pulling server-side code into the browser
 * bundle.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export const SEVERITY_THEME: Record<Severity, { label: string; badgeClass: string }> = {
  CRITICAL: { label: 'Interpol Breach', badgeClass: 'bg-red-500' },
  HIGH: { label: 'Hostage Crisis', badgeClass: 'bg-orange-500' },
  MEDIUM: { label: 'Camera Glitch', badgeClass: 'bg-yellow-500 text-black' },
  LOW: { label: 'Loose Screws', badgeClass: 'bg-slate-500' },
  NONE: { label: 'All Clear', badgeClass: 'bg-emerald-500' },
};

export function getSeverityTheme(severity: string) {
  return SEVERITY_THEME[severity as Severity] ?? {
    label: severity,
    badgeClass: 'bg-slate-500',
  };
}