import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: { getBuffer: vi.fn(), set: vi.fn() },
}));

vi.mock("@/lib/redis", () => ({ redis: mockRedis }));

import { audioCacheKey, getOrSynthesize, getCachedAudio } from "./audio-cache";

describe("audio-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.getBuffer.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue("OK");
  });

  it("generates deterministic keys", () => {
    expect(audioCacheKey("hi", "v1", "m1")).toBe(audioCacheKey("hi", "v1", "m1"));
  });

  it("avoids collisions between concatenated inputs", () => {
    expect(audioCacheKey("ab", "c", "m")).not.toBe(audioCacheKey("a", "bc", "m"));
  });

  it("changes key when voice or model changes", () => {
    const base = audioCacheKey("hi", "v1", "m1");
    expect(audioCacheKey("hi", "v2", "m1")).not.toBe(base);
    expect(audioCacheKey("hi", "v1", "m2")).not.toBe(base);
  });

  it("synthesizes on miss and writes to redis with TTL", async () => {
    const synth = vi.fn().mockResolvedValue(Buffer.from("audio"));
    const out = await getOrSynthesize("miss-text", "v1", "m1", synth);
    expect(out.toString()).toBe("audio");
    expect(synth).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), "EX", 86400);
  });

  it("returns cached audio without synthesizing on redis hit", async () => {
    mockRedis.getBuffer.mockResolvedValue(Buffer.from("cached"));
    const synth = vi.fn();
    const out = await getOrSynthesize("hit-text", "v1", "m1", synth);
    expect(out.toString()).toBe("cached");
    expect(synth).not.toHaveBeenCalled();
  });

  it("falls back to local cache when redis fails", async () => {
    mockRedis.getBuffer.mockRejectedValue(new Error("redis down"));
    mockRedis.set.mockRejectedValue(new Error("redis down"));
    const synth = vi.fn().mockResolvedValue(Buffer.from("local"));
    await getOrSynthesize("fallback-text", "v1", "m1", synth);
    const key = audioCacheKey("fallback-text", "v1", "m1");
    const hit = await getCachedAudio(key);
    expect(hit?.toString()).toBe("local");
  });
});
