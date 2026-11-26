/**
 * Dead-Letter Queue (DLQ) & Durable Replay Engine (#2061)
 *
 * Captures, quarantines, and replays failed or circuit-broken outbound webhook
 * deliveries. Eliminates silent drops, preserves event payload integrity,
 * and empowers security operators to re-dispatch events after remote receiver recovery.
 */

import crypto from "node:crypto";
import type { OutboundEventEnvelope, OutboundEventType } from "./outbound-types";
import { deliverOutboundWebhook, type DeliveryOptions, type DeliveryResult } from "./outbound-dispatcher";

export type DlqStatus = "quarantined" | "replaying" | "replayed" | "purged";

export interface DeadLetterEntry {
  id: string;
  webhookId: string;
  url: string;
  secret: string;
  event: OutboundEventType;
  envelope: OutboundEventEnvelope;
  failureReason: string;
  statusCode: number | null;
  attempts: number;
  circuitBroken: boolean;
  firstFailedAt: string;
  lastAttemptAt: string;
  status: DlqStatus;
  replayedAt?: string | null;
  replayError?: string | null;
}

export interface EnqueueDlqInput {
  webhookId: string;
  url: string;
  secret: string;
  event: OutboundEventType;
  envelope: OutboundEventEnvelope;
  failureReason: string;
  statusCode?: number | null;
  attempts?: number;
  circuitBroken?: boolean;
}

export interface DlqFilterOptions {
  webhookId?: string;
  status?: DlqStatus;
  event?: OutboundEventType;
  circuitBroken?: boolean;
  limit?: number;
  offset?: number;
}

export interface ReplayResult {
  dlqId: string;
  success: boolean;
  statusCode: number | null;
  error: string | null;
  deliveryResult: DeliveryResult;
}

export interface BatchReplayResult {
  total: number;
  succeeded: number;
  failed: number;
  results: ReplayResult[];
}

const MAX_DLQ_CAPACITY = 2000;
const dlqStore = new Map<string, DeadLetterEntry>();

/**
 * Enqueue a permanently failed or circuit-broken outbound delivery into the DLQ.
 */
export function enqueueToDlq(input: EnqueueDlqInput): DeadLetterEntry {
  const timestamp = new Date().toISOString();
  const id = `dlq_${crypto.randomUUID()}`;

  // Enforce memory bounds: purge oldest replayed/purged entries if capacity exceeded
  if (dlqStore.size >= MAX_DLQ_CAPACITY) {
    for (const [key, entry] of dlqStore) {
      if (entry.status === "replayed" || entry.status === "purged") {
        dlqStore.delete(key);
        break;
      }
    }
  }

  const entry: DeadLetterEntry = {
    id,
    webhookId: input.webhookId,
    url: input.url,
    secret: input.secret,
    event: input.event,
    envelope: input.envelope,
    failureReason: input.failureReason,
    statusCode: input.statusCode ?? null,
    attempts: input.attempts ?? 1,
    circuitBroken: Boolean(input.circuitBroken),
    firstFailedAt: timestamp,
    lastAttemptAt: timestamp,
    status: "quarantined",
    replayedAt: null,
    replayError: null,
  };

  dlqStore.set(id, entry);
  return entry;
}

/**
 * Retrieve an individual DLQ entry by ID.
 */
export function getDlqEntry(id: string): DeadLetterEntry | null {
  return dlqStore.get(id) ?? null;
}

/**
 * Query and filter DLQ entries.
 */
export function listDlqEntries(filter: DlqFilterOptions = {}): DeadLetterEntry[] {
  let entries = Array.from(dlqStore.values());

  if (filter.webhookId) {
    entries = entries.filter((e) => e.webhookId === filter.webhookId);
  }
  if (filter.status) {
    entries = entries.filter((e) => e.status === filter.status);
  }
  if (filter.event) {
    entries = entries.filter((e) => e.event === filter.event);
  }
  if (filter.circuitBroken !== undefined) {
    entries = entries.filter((e) => e.circuitBroken === filter.circuitBroken);
  }

  // Sort newest first
  entries.sort(
    (a, b) => new Date(b.lastAttemptAt).getTime() - new Date(a.lastAttemptAt).getTime(),
  );

  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? entries.length;
  return entries.slice(offset, offset + limit);
}

/**
 * Purge a single entry from the DLQ.
 */
export function purgeDlqEntry(id: string): boolean {
  const entry = dlqStore.get(id);
  if (!entry) return false;
  entry.status = "purged";
  return true;
}

/**
 * Purge all entries matching criteria or all entries.
 */
export function purgeAllDlq(): number {
  const count = dlqStore.size;
  dlqStore.clear();
  return count;
}

/**
 * Replay an individual quarantined DLQ entry.
 */
export async function replayDlqEntry(
  id: string,
  options: DeliveryOptions = {},
): Promise<ReplayResult> {
  const entry = dlqStore.get(id);
  if (!entry) {
    throw new Error(`DLQ entry not found: "${id}"`);
  }

  entry.status = "replaying";
  entry.lastAttemptAt = new Date().toISOString();

  // Redeliver without re-enqueuing recursively
  const deliveryResult = await deliverOutboundWebhook(
    { id: entry.webhookId, url: entry.url, secret: entry.secret },
    entry.envelope,
    { ...options, skipDlq: true },
  );

  if (deliveryResult.success) {
    entry.status = "replayed";
    entry.replayedAt = new Date().toISOString();
    entry.replayError = null;
    entry.statusCode = deliveryResult.statusCode ?? 200;
  } else {
    entry.status = "quarantined";
    entry.attempts += deliveryResult.attempts;
    entry.statusCode = deliveryResult.statusCode ?? null;
    entry.replayError = deliveryResult.error ?? "Redelivery failed";
  }

  return {
    dlqId: id,
    success: deliveryResult.success,
    statusCode: deliveryResult.statusCode ?? null,
    error: deliveryResult.error ?? null,
    deliveryResult,
  };
}

/**
 * Batch replay multiple quarantined DLQ entries.
 */
export async function batchReplayDlq(
  ids?: string[],
  options: DeliveryOptions = {},
): Promise<BatchReplayResult> {
  const targetIds = ids && ids.length > 0
    ? ids
    : listDlqEntries({ status: "quarantined" }).map((e) => e.id);

  const results: ReplayResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const id of targetIds) {
    try {
      const res = await replayDlqEntry(id, options);
      results.push(res);
      if (res.success) {
        succeeded++;
      } else {
        failed++;
      }
    } catch (err: any) {
      failed++;
      results.push({
        dlqId: id,
        success: false,
        statusCode: null,
        error: err?.message || String(err),
        deliveryResult: {
          success: false,
          webhookId: "unknown",
          eventId: "unknown",
          event: "scan.completed",
          error: err?.message || String(err),
          attempts: 0,
        },
      });
    }
  }

  return {
    total: targetIds.length,
    succeeded,
    failed,
    results,
  };
}

/**
 * Clear memory store (for testing only).
 */
export function clearDlqStore(): void {
  dlqStore.clear();
}
