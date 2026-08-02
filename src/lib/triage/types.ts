// Shared triage constants and types. Kept out of the `"use server"` action
// module: Next.js requires that a `"use server"` file only export async
// functions, and this module exports runtime values + types.
//
// The lifecycle a finding can move through. OPEN is the implicit default (no
// triage row); the other three suppress the finding from the dashboard tiles,
// and FALSE_POSITIVE / IGNORED additionally stop it BLOCKing the PR on re-scan.
export const TRIAGE_STATUSES = ["OPEN", "RESOLVED", "FALSE_POSITIVE", "IGNORED"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

export interface SetFindingStatusInput {
  repositoryId: string;
  fingerprint: string;
  status: TriageStatus;
  note?: string | null;
}

export interface SetFindingStatusResult {
  ok: boolean;
  error?: string;
}
