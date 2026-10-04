import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryRaw = vi.hoisted(() => vi.fn());
const redisHolder = vi.hoisted(() => ({ redis: null as { ping: () => Promise<unknown> } | null }));

vi.mock("@/lib/prisma", () => ({ default: { $queryRaw: mockQueryRaw } }));
vi.mock("@/lib/redis", () => redisHolder);

const fetchMock = vi.fn();

/** A fresh module per test: the Groq probe cache is module state. */
async function load() {
  vi.resetModules();
  return import("./health-check");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GROQ_API_KEY", "gsk_test");
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  mockQueryRaw.mockReset().mockResolvedValue([{ "?column?": 1 }]);
  redisHolder.redis = { ping: vi.fn().mockResolvedValue("PONG") };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function component(
  report: { components: Array<{ name: string; message?: string }> },
  name: string,
) {
  return report.components.find((c) => c.name === name);
}

describe("runHealthCheck", () => {
  it("reports healthy when every probe succeeds", async () => {
    const { runHealthCheck } = await load();

    const report = await runHealthCheck();

    expect(report.status).toBe("healthy");
    expect(report.timestamp).toBe("2026-09-19T00:00:00.000Z");
    expect(report.components.map((c) => [c.name, c.status])).toEqual([
      ["PostgreSQL", "healthy"],
      ["Redis", "healthy"],
      ["Groq LLM", "healthy"],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer gsk_test" } }),
    );
  });

  it("is down when the database probe fails, with a bounded message", async () => {
    mockQueryRaw.mockRejectedValue(new Error("x".repeat(500)));
    const { runHealthCheck } = await load();

    const report = await runHealthCheck();

    expect(report.status).toBe("down");
    expect(component(report, "PostgreSQL")).toMatchObject({ status: "down" });
    expect(component(report, "PostgreSQL")?.message).toHaveLength(200);
  });

  it("falls back to a generic database message", async () => {
    mockQueryRaw.mockRejectedValue({});
    const { runHealthCheck } = await load();

    const report = await runHealthCheck();

    expect(component(report, "PostgreSQL")).toMatchObject({ message: "Unknown database error" });
  });

  it("is degraded, not down, when Redis is missing or unreachable", async () => {
    redisHolder.redis = null;
    let { runHealthCheck } = await load();
    let report = await runHealthCheck();
    expect(report.status).toBe("degraded");
    expect(component(report, "Redis")).toMatchObject({
      status: "degraded",
      message: "Not configured",
    });

    redisHolder.redis = { ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    ({ runHealthCheck } = await load());
    report = await runHealthCheck();
    expect(component(report, "Redis")).toMatchObject({
      status: "degraded",
      message: "ECONNREFUSED",
    });

    redisHolder.redis = { ping: vi.fn().mockRejectedValue({}) };
    ({ runHealthCheck } = await load());
    report = await runHealthCheck();
    expect(component(report, "Redis")).toMatchObject({ message: "Connection failed" });
  });

  it.each([undefined, "", "dummy-key-for-build"])(
    "does not call Groq when the key is %j",
    async (key) => {
      vi.stubEnv("GROQ_API_KEY", key as string);
      const { runHealthCheck } = await load();

      const report = await runHealthCheck();

      expect(component(report, "Groq LLM")).toMatchObject({
        status: "degraded",
        message: "API key not configured",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("is degraded when Groq answers with an error status or cannot be reached", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    let { runHealthCheck } = await load();
    expect(component(await runHealthCheck(), "Groq LLM")).toMatchObject({
      status: "degraded",
      message: "HTTP 401",
    });

    fetchMock.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    ({ runHealthCheck } = await load());
    expect(component(await runHealthCheck(), "Groq LLM")).toMatchObject({
      message: "The operation was aborted due to timeout",
    });

    fetchMock.mockRejectedValueOnce({});
    ({ runHealthCheck } = await load());
    expect(component(await runHealthCheck(), "Groq LLM")).toMatchObject({
      message: "Connection failed",
    });
  });

  it("reports uptime in whole seconds since the module loaded", async () => {
    const { runHealthCheck } = await load();
    vi.advanceTimersByTime(90_500);

    expect((await runHealthCheck()).uptime).toBe(90);
  });
});

describe("Groq probe reuse", () => {
  it("makes one Groq request per TTL window however often the endpoint is hit", async () => {
    const { runHealthCheck, GROQ_PROBE_TTL_MS } = await load();

    for (let i = 0; i < 25; i++) await runHealthCheck();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(GROQ_PROBE_TTL_MS - 1);
    await runHealthCheck();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await runHealthCheck();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent checks", async () => {
    const { runHealthCheck } = await load();

    await Promise.all([runHealthCheck(), runHealthCheck(), runHealthCheck()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still probes the database and Redis on every call", async () => {
    const { runHealthCheck } = await load();

    await runHealthCheck();
    await runHealthCheck();

    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(redisHolder.redis!.ping).toHaveBeenCalledTimes(2);
  });
});
