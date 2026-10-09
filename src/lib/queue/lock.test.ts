import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("uuid", () => ({ v4: () => "test-token" }));
vi.mock("./redis", () => ({ redis: { set: vi.fn(), eval: vi.fn() } }));

import { redis } from "./redis";
import { acquireLock, extendLock, releaseLock, startLockHeartbeat } from "./lock";

const set = vi.mocked(redis.set);
const evalScript = vi.mocked(redis.eval);

/** Renewal calls only; `eval` is also used by release. */
const renewals = () =>
  evalScript.mock.calls.filter((call: unknown[]) => /pexpire/.test(String(call[0])));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("acquireLock", () => {
  it("returns the token when SET NX succeeds", async () => {
    set.mockResolvedValue("OK");
    await expect(acquireLock("k", 60_000)).resolves.toBe("test-token");
    expect(set).toHaveBeenCalledWith("k", "test-token", "PX", 60_000, "NX");
  });

  it("returns null when the lock is already held", async () => {
    set.mockResolvedValue(null);
    await expect(acquireLock("k", 60_000)).resolves.toBeNull();
  });

  it("does not touch Redis in mock-DB mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_MOCK_DB", "true");
    await expect(acquireLock("k", 60_000)).resolves.toMatch(/^mock-lock-token-/);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("extendLock", () => {
  it("extends with a token-checked script and the new TTL", async () => {
    evalScript.mockResolvedValue(1);
    await expect(extendLock("k", "tok", 60_000)).resolves.toBe(true);

    const [script, numKeys, key, token, ttl] = evalScript.mock.calls[0];
    expect(script).toMatch(/get.*==.*ARGV\[1\][\s\S]*pexpire/);
    expect([numKeys, key, token, ttl]).toEqual([1, "k", "tok", 60_000]);
  });

  it("resolves false when the lock is no longer ours", async () => {
    evalScript.mockResolvedValue(0);
    await expect(extendLock("k", "tok", 60_000)).resolves.toBe(false);
  });

  it("rejects when Redis is unreachable, so callers can tell it from a lost lock", async () => {
    evalScript.mockRejectedValue(new Error("ECONNRESET"));
    await expect(extendLock("k", "tok", 60_000)).rejects.toThrow("ECONNRESET");
  });

  it("does not touch Redis in mock-DB mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_MOCK_DB", "true");
    await expect(extendLock("k", "tok", 60_000)).resolves.toBe(true);
    expect(evalScript).not.toHaveBeenCalled();
  });
});

describe("releaseLock", () => {
  it("resolves true only when the token matched", async () => {
    evalScript.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(releaseLock("k", "tok")).resolves.toBe(true);
    await expect(releaseLock("k", "tok")).resolves.toBe(false);
  });

  it("swallows a Redis error and reports failure", async () => {
    evalScript.mockRejectedValue(new Error("boom"));
    await expect(releaseLock("k", "tok")).resolves.toBe(false);
  });
});

describe("startLockHeartbeat", () => {
  it("rejects an interval that cannot keep the lease alive", () => {
    expect(() => startLockHeartbeat("k", "tok", 100, 100)).toThrow(RangeError);
    expect(() => startLockHeartbeat("k", "tok", 100, 0)).toThrow(RangeError);
  });

  it("keeps renewing the lease until stopped", async () => {
    evalScript.mockResolvedValue(1);
    const heartbeat = startLockHeartbeat("k", "tok", 300, 10);

    await vi.waitFor(() => expect(renewals().length).toBeGreaterThanOrEqual(3));
    expect(heartbeat.lost).toBe(false);

    heartbeat.stop();
    const seen = renewals().length;
    await sleep(60);
    expect(renewals().length).toBe(seen);
  });

  it("marks the lock lost, stops, and calls onLost when a renewal finds it gone", async () => {
    evalScript.mockResolvedValue(0);
    const onLost = vi.fn();
    const heartbeat = startLockHeartbeat("k", "tok", 300, 10, onLost);

    await vi.waitFor(() => expect(heartbeat.lost).toBe(true));
    expect(onLost).toHaveBeenCalledTimes(1);

    const seen = renewals().length;
    await sleep(60);
    expect(renewals().length).toBe(seen);
  });

  it("keeps trying after a transient Redis error instead of giving up the lock", async () => {
    evalScript.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue(1);
    const onLost = vi.fn();
    const heartbeat = startLockHeartbeat("k", "tok", 300, 10, onLost);

    await vi.waitFor(() => expect(renewals().length).toBeGreaterThanOrEqual(3));
    expect(heartbeat.lost).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  it("does not report a lost lock when stopped while a renewal is in flight", async () => {
    let finishRenewal: (value: number) => void = () => {};
    evalScript.mockImplementation(
      () => new Promise<number>((resolve) => (finishRenewal = resolve)),
    );
    const onLost = vi.fn();
    const heartbeat = startLockHeartbeat("k", "tok", 300, 10, onLost);

    await vi.waitFor(() => expect(renewals().length).toBe(1));
    heartbeat.stop(); // the holder finished and is releasing the lock
    finishRenewal(0); // ...so the in-flight renewal finds it gone

    await sleep(30);
    expect(heartbeat.lost).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("never runs overlapping renewals against a slow Redis", async () => {
    let active = 0;
    let peak = 0;
    evalScript.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(40);
      active--;
      return 1;
    });
    const heartbeat = startLockHeartbeat("k", "tok", 300, 10);

    await vi.waitFor(() => expect(renewals().length).toBeGreaterThanOrEqual(2));
    heartbeat.stop();
    expect(peak).toBe(1);
  });

  it("stop() is idempotent", () => {
    const heartbeat = startLockHeartbeat("k", "tok", 300, 10);
    heartbeat.stop();
    expect(() => heartbeat.stop()).not.toThrow();
  });
});
