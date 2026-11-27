import { describe, it, expect } from "vitest";
import {
  WebhookReplayStore,
  deriveWebhookReplayKey,
  DEFAULT_REPLAY_STORE_MAX_ENTRIES,
} from "./webhook-replay-store";
import { admitWebhookRequest, signPayloadV1 } from "./hmacSigner";

describe("Bounded TTL Nonce & Delivery-ID Anti-Replay Store (#2188)", () => {
  it("accepts first-seen nonces and rejects duplicates within the TTL window", () => {
    const store = new WebhookReplayStore({ maxEntries: 100 });
    const t0 = 1_700_000_000_000;

    const first = store.consume("delivery:evt-1", 300, t0);
    expect(first.accepted).toBe(true);
    expect(store.size).toBe(1);

    // Duplicate 10s later -> rejected
    const replay = store.consume("delivery:evt-1", 300, t0 + 10_000);
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toContain("Replay detected");

    // Different delivery ID -> accepted
    const second = store.consume("delivery:evt-2", 300, t0 + 10_000);
    expect(second.accepted).toBe(true);
    expect(store.size).toBe(2);
  });

  it("allows re-admission once the nonce TTL has expired", () => {
    const store = new WebhookReplayStore({ maxEntries: 100 });
    const t0 = 1_700_000_000_000;

    expect(store.consume("delivery:evt-exp", 60, t0).accepted).toBe(true);
    expect(store.consume("delivery:evt-exp", 60, t0 + 59_000).accepted).toBe(false);

    // After 60s TTL -> accepted again
    expect(store.consume("delivery:evt-exp", 60, t0 + 60_001).accepted).toBe(true);
  });

  it("enforces strict bounded capacity under high-volume spoofed nonce floods", () => {
    const smallStore = new WebhookReplayStore({ maxEntries: 5 });
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < 20; i++) {
      expect(smallStore.consume(`nonce-${i}`, 300, t0 + i).accepted).toBe(true);
    }
    expect(smallStore.size).toBe(5);

    const defaultStore = new WebhookReplayStore();
    for (let i = 0; i < 55_000; i++) {
      defaultStore.consume(`flood-${i}`, 300, t0);
    }
    expect(defaultStore.size).toBe(DEFAULT_REPLAY_STORE_MAX_ENTRIES);
  });

  it("derives deterministic replay keys from deliveryId or signature digest fallback", () => {
    expect(deriveWebhookReplayKey("t=1,v1=abc", "1", "evt_123")).toBe("delivery:evt_123");
    const fallback1 = deriveWebhookReplayKey("t=1,v1=abc", "1");
    const fallback2 = deriveWebhookReplayKey("t=1,v1=abc", "1");
    expect(fallback1).toMatch(/^sig:[a-f0-9]{64}$/);
    expect(fallback1).toBe(fallback2);
  });

  it("integrates with admitWebhookRequest in hmacSigner.ts to block within-window replays with 409", () => {
    const store = new WebhookReplayStore({ maxEntries: 100 });
    const secret = "whsec_test_anti_replay_secret";
    const body = JSON.stringify({ event: "scan.completed" });
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const sig = signPayloadV1(body, secret, nowSec);

    const first = admitWebhookRequest(body, secret, sig, String(nowSec), 300, {
      deliveryId: "deliv-uuid-1",
      replayStore: store,
      now: nowMs,
    });
    expect(first.ok).toBe(true);

    const replay = admitWebhookRequest(body, secret, sig, String(nowSec), 300, {
      deliveryId: "deliv-uuid-1",
      replayStore: store,
      now: nowMs + 5_000,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.status).toBe(409);
      expect(replay.message).toContain("Replay detected");
    }

    // Fallback signature digest replay protection when no deliveryId is supplied
    const sigFirst = admitWebhookRequest(body, secret, sig, String(nowSec), 300, {
      enforceReplayCheck: true,
      replayStore: store,
      now: nowMs,
    });
    expect(sigFirst.ok).toBe(true);

    const sigReplay = admitWebhookRequest(body, secret, sig, String(nowSec), 300, {
      enforceReplayCheck: true,
      replayStore: store,
      now: nowMs + 1_000,
    });
    expect(sigReplay.ok).toBe(false);
    if (!sigReplay.ok) {
      expect(sigReplay.status).toBe(409);
    }
  });
});
