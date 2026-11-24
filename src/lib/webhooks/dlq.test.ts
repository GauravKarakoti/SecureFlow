import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enqueueToDlq,
  getDlqEntry,
  listDlqEntries,
  purgeDlqEntry,
  purgeAllDlq,
  replayDlqEntry,
  batchReplayDlq,
  clearDlqStore,
} from "./dlq";
import type { OutboundEventEnvelope } from "./outbound-types";

describe("Dead-Letter Queue (DLQ) & Durable Replay Engine (#2061)", () => {
  const secret = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const sampleEnvelope: OutboundEventEnvelope = {
    id: "evt_test123",
    event: "scan.completed",
    timestamp: new Date().toISOString(),
    data: { repository: "owner/repo", prNumber: 42 },
  };

  beforeEach(() => {
    clearDlqStore();
  });

  it("enqueues failed delivery to DLQ preserving full envelope and failure context", () => {
    const entry = enqueueToDlq({
      webhookId: "wh_1",
      url: "https://siem.corp.internal/hooks",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "Endpoint answered HTTP 503 Service Unavailable",
      statusCode: 503,
      attempts: 3,
      circuitBroken: false,
    });

    expect(entry.id).toMatch(/^dlq_/);
    expect(entry.status).toBe("quarantined");
    expect(entry.webhookId).toBe("wh_1");
    expect(entry.url).toBe("https://siem.corp.internal/hooks");
    expect(entry.failureReason).toContain("HTTP 503");
    expect(entry.statusCode).toBe(503);
    expect(entry.attempts).toBe(3);
    expect(entry.circuitBroken).toBe(false);
    expect(entry.envelope.id).toBe("evt_test123");
  });

  it("enqueues circuit-broken deliveries with circuitBroken flag set", () => {
    const entry = enqueueToDlq({
      webhookId: "wh_2",
      url: "https://unresponsive-host.com/hooks",
      secret,
      event: "scan.blocked",
      envelope: sampleEnvelope,
      failureReason: "Delivery quenched: Circuit breaker is OPEN for https://unresponsive-host.com",
      statusCode: null,
      attempts: 0,
      circuitBroken: true,
    });

    expect(entry.circuitBroken).toBe(true);
    expect(entry.attempts).toBe(0);
    expect(entry.status).toBe("quarantined");
  });

  it("retrieves and filters DLQ entries", () => {
    enqueueToDlq({
      webhookId: "wh_a",
      url: "https://a.com",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "500",
    });
    enqueueToDlq({
      webhookId: "wh_b",
      url: "https://b.com",
      secret,
      event: "scan.blocked",
      envelope: sampleEnvelope,
      failureReason: "502",
      circuitBroken: true,
    });

    const all = listDlqEntries();
    expect(all).toHaveLength(2);

    const forA = listDlqEntries({ webhookId: "wh_a" });
    expect(forA).toHaveLength(1);
    expect(forA[0]?.webhookId).toBe("wh_a");

    const circuitBrokenOnly = listDlqEntries({ circuitBroken: true });
    expect(circuitBrokenOnly).toHaveLength(1);
    expect(circuitBrokenOnly[0]?.webhookId).toBe("wh_b");
  });

  it("purges individual and all DLQ entries", () => {
    const entry1 = enqueueToDlq({
      webhookId: "wh_1",
      url: "https://a.com",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "error",
    });
    const entry2 = enqueueToDlq({
      webhookId: "wh_2",
      url: "https://b.com",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "error",
    });

    expect(purgeDlqEntry(entry1.id)).toBe(true);
    expect(getDlqEntry(entry1.id)?.status).toBe("purged");

    const purgedCount = purgeAllDlq();
    expect(purgedCount).toBe(2);
    expect(listDlqEntries()).toHaveLength(0);
  });

  it("replays quarantined entry successfully when endpoint recovers", async () => {
    const entry = enqueueToDlq({
      webhookId: "wh_recover",
      url: "https://recovered.com/webhook",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "Previous 503",
      statusCode: 503,
      attempts: 3,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });

    const mockDns = async () => ["93.184.216.34"];

    const replayResult = await replayDlqEntry(entry.id, {
      fetchFn: mockFetch as any,
      dnsLookup: mockDns,
      persistLog: false,
    });

    expect(replayResult.success).toBe(true);
    expect(replayResult.statusCode).toBe(200);

    const updated = getDlqEntry(entry.id);
    expect(updated?.status).toBe("replayed");
    expect(updated?.replayedAt).not.toBeNull();
    expect(updated?.replayError).toBeNull();
  });

  it("keeps status quarantined and updates error when replay fails", async () => {
    const entry = enqueueToDlq({
      webhookId: "wh_still_down",
      url: "https://still-down.com/webhook",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "Previous 500",
      statusCode: 500,
      attempts: 3,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const mockDns = async () => ["93.184.216.34"];

    const replayResult = await replayDlqEntry(entry.id, {
      fetchFn: mockFetch as any,
      dnsLookup: mockDns,
      persistLog: false,
      maxAttempts: 1,
    });

    expect(replayResult.success).toBe(false);
    expect(replayResult.statusCode).toBe(500);

    const updated = getDlqEntry(entry.id);
    expect(updated?.status).toBe("quarantined");
    expect(updated?.replayError).toContain("500");
  });

  it("batch replays multiple DLQ entries", async () => {
    const e1 = enqueueToDlq({
      webhookId: "wh_1",
      url: "https://svc1.com/hook",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "error",
    });
    const e2 = enqueueToDlq({
      webhookId: "wh_2",
      url: "https://svc2.com/hook",
      secret,
      event: "scan.completed",
      envelope: sampleEnvelope,
      failureReason: "error",
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const mockDns = async () => ["93.184.216.34"];

    const batchResult = await batchReplayDlq([e1.id, e2.id], {
      fetchFn: mockFetch as any,
      dnsLookup: mockDns,
      persistLog: false,
    });

    expect(batchResult.total).toBe(2);
    expect(batchResult.succeeded).toBe(2);
    expect(batchResult.failed).toBe(0);
  });
});
