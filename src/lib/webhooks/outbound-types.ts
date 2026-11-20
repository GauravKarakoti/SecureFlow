/**
 * Shared types and constants for Outbound Webhooks (#1866).
 * Safe for both client-side and server-side usage.
 */

export type OutboundEventType =
  "scan.completed" | "scan.blocked" | "finding.created" | "finding.dismissed";

export const OUTBOUND_EVENT_TYPES: readonly OutboundEventType[] = [
  "scan.completed",
  "scan.blocked",
  "finding.created",
  "finding.dismissed",
] as const;

export function isValidOutboundEvent(event: string): event is OutboundEventType {
  return (OUTBOUND_EVENT_TYPES as readonly string[]).includes(event);
}

export interface OutboundEventEnvelope<T = Record<string, unknown>> {
  id: string;
  event: OutboundEventType;
  timestamp: string;
  data: T;
}

export interface MinimalFindingSummary {
  id?: string;
  type?: string;
  severity?: string;
  fileLocation?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  fingerprint?: string | null;
}
