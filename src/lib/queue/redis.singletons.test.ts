import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Array<{ url: string; options: Record<string, unknown> }>);

vi.mock("ioredis", () => ({
  default: vi.fn(function (this: any, url: string, options: Record<string, unknown>) {
    this.url = url;
    this.options = options;
    created.push({ url, options });
  }),
}));

const globals = globalThis as Record<string, unknown>;

async function loadInOrder(first: "rate-limit" | "queue") {
  vi.resetModules();
  if (first === "rate-limit") {
    const rateLimit = await import("@/lib/redis");
    const queue = await import("@/lib/queue/redis");
    return { rateLimit: rateLimit.redis as any, queue: queue.redis as any };
  }
  const queue = await import("@/lib/queue/redis");
  const rateLimit = await import("@/lib/redis");
  return { rateLimit: rateLimit.redis as any, queue: queue.redis as any };
}

beforeEach(() => {
  created.length = 0;
  for (const key of ["redis", "queueRedis", "rateLimitRedis"]) delete globals[key];
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("REDIS_URL", "redis://cache.internal:6379");
  vi.stubEnv("NEXT_PUBLIC_MOCK_DB", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of ["redis", "queueRedis", "rateLimitRedis"]) delete globals[key];
});

describe("Redis client singletons", () => {
  it.each(["rate-limit", "queue"] as const)(
    "keeps the queue and rate-limit clients separate when the %s module loads first",
    async (first) => {
      const { rateLimit, queue } = await loadInOrder(first);

      expect(queue).not.toBe(rateLimit);
      // BullMQ's Worker throws unless this is null.
      expect(queue.options.maxRetriesPerRequest).toBeNull();
      expect(rateLimit.options.maxRetriesPerRequest).toBe(3);
    },
  );

  it("never hands the queue's MOCK_DB stub to the rate limiter", async () => {
    vi.stubEnv("NEXT_PUBLIC_MOCK_DB", "true");

    const { rateLimit, queue } = await loadInOrder("queue");

    expect(typeof queue.pipeline).toBe("undefined");
    expect(rateLimit).not.toBe(queue);
    expect(rateLimit.options.maxRetriesPerRequest).toBe(3);
  });

  it("still reuses each client across reloads in development", async () => {
    const firstLoad = await loadInOrder("queue");
    const secondLoad = await loadInOrder("rate-limit");

    expect(secondLoad.queue).toBe(firstLoad.queue);
    expect(secondLoad.rateLimit).toBe(firstLoad.rateLimit);
    expect(created).toHaveLength(2);
  });
});
