/**
 * Tests for the heist transmission SSE route (#530).
 *
 * The route never observed the client going away: it had no `cancel()` handler,
 * wired no AbortSignal into the generator, and its catch block called `send()`
 * again after the controller was already closed — throwing a second time, so
 * the error event was never delivered and `close()` never ran. Meanwhile the
 * Groq generation carried on for a reader that had disconnected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HeistStreamEvent } from "@/ai/flows/heist-message-stream";

const streamHeistMessageMock = vi.fn();

// Mocked wholesale rather than via importActual: the real module pulls in
// @/ai/genkit → genkitx-groq, which has no business being loaded to test the
// route's stream lifecycle.
vi.mock("@/ai/flows/heist-message-stream", () => ({
  streamHeistMessage: (...args: unknown[]) => streamHeistMessageMock(...args),
  FALLBACK_HEIST_MESSAGE: "Bella ciao, accomplice. Zero traces remain.",
}));

const { createHeistStream, parseHeistParams, parseBoundedInt } = await import("./route");

const decoder = new TextDecoder();

/** Read every SSE event from a stream until it closes. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<HeistStreamEvent[]> {
  const reader = stream.getReader();
  const events: HeistStreamEvent[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) events.push(JSON.parse(trimmed.slice(6)));
    }
  }

  return events;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  streamHeistMessageMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseBoundedInt", () => {
  it("returns undefined for a missing parameter", () => {
    expect(parseBoundedInt(null, 0, 100)).toBeUndefined();
  });

  it("returns undefined for an empty string rather than coercing it to 0", () => {
    expect(parseBoundedInt("", 0, 100)).toBeUndefined();
    expect(parseBoundedInt("   ", 0, 100)).toBeUndefined();
  });

  it("parses a valid integer", () => {
    expect(parseBoundedInt("42", 0, 100)).toBe(42);
  });

  it("rounds a float into an integer", () => {
    expect(parseBoundedInt("42.6", 0, 100)).toBe(43);
  });

  it("rejects values outside the range", () => {
    expect(parseBoundedInt("-1", 0, 100)).toBeUndefined();
    expect(parseBoundedInt("101", 0, 100)).toBeUndefined();
  });

  it("rejects non-finite values", () => {
    expect(parseBoundedInt("Infinity", 0, 100)).toBeUndefined();
    expect(parseBoundedInt("1e999", 0, 100)).toBeUndefined();
    expect(parseBoundedInt("NaN", 0, 100)).toBeUndefined();
    expect(parseBoundedInt("banana", 0, 100)).toBeUndefined();
  });
});

describe("parseHeistParams", () => {
  const params = (qs: string) => parseHeistParams(new URLSearchParams(qs));

  it("falls back to the default project name", () => {
    expect(params("")).toEqual({ projectName: "The Royal Mint" });
  });

  it("ignores a whitespace-only project name", () => {
    expect(params("project=%20%20")).toEqual({ projectName: "The Royal Mint" });
  });

  it("caps an over-long project name", () => {
    const result = params(`project=${"a".repeat(500)}`);

    expect(result.projectName).toHaveLength(120);
  });

  it("omits score entirely when the parameter is empty", () => {
    expect(params("score=")).not.toHaveProperty("score");
  });

  it("keeps a valid score", () => {
    expect(params("score=87")).toMatchObject({ score: 87 });
  });

  it("drops an out-of-range score", () => {
    expect(params("score=500")).not.toHaveProperty("score");
    expect(params("score=-5")).not.toHaveProperty("score");
  });

  it("normalises the rank to upper case", () => {
    expect(params("rank=s")).toMatchObject({ rank: "S" });
  });

  it("drops an unknown rank", () => {
    expect(params("rank=Z")).not.toHaveProperty("rank");
  });

  it("keeps a valid findings count", () => {
    expect(params("findingsCount=12")).toMatchObject({ findingsCount: 12 });
  });

  it("drops a negative findings count", () => {
    expect(params("findingsCount=-3")).not.toHaveProperty("findingsCount");
  });

  it("builds a complete input", () => {
    expect(params("project=Vault&score=91&rank=a&findingsCount=4")).toEqual({
      projectName: "Vault",
      score: 91,
      rank: "A",
      findingsCount: 4,
    });
  });
});

describe("createHeistStream — happy path", () => {
  it("emits chunks then a done event and closes", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "chunk", text: "Bella" };
      yield { type: "chunk", text: "Bella ciao" };
      yield { type: "done", message: "Bella ciao" };
    });

    const events = await readAll(createHeistStream({ projectName: "Vault" }));

    expect(events).toEqual([
      { type: "chunk", text: "Bella" },
      { type: "chunk", text: "Bella ciao" },
      { type: "done", message: "Bella ciao" },
    ]);
  });

  it("forwards an error event from the generator", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "error", message: "rate limited" };
    });

    const events = await readAll(createHeistStream({ projectName: "Vault" }));

    expect(events).toEqual([{ type: "error", message: "rate limited" }]);
  });

  it("falls back to done when the generator ends without a terminal event", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "chunk", text: "partial" };
    });

    const events = await readAll(createHeistStream({ projectName: "Vault" }));

    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("passes an abort signal down to the generator", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "done", message: "ok" };
    });

    await readAll(createHeistStream({ projectName: "Vault" }));

    expect(streamHeistMessageMock).toHaveBeenCalledWith(
      { projectName: "Vault" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("createHeistStream — client disconnect", () => {
  it("aborts the generator's signal when the reader cancels", async () => {
    let observed: AbortSignal | undefined;

    streamHeistMessageMock.mockImplementation(async function* (
      _input: unknown,
      options: { signal?: AbortSignal },
    ) {
      observed = options.signal;
      yield { type: "chunk", text: "one" };
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: "chunk", text: "two" };
    });

    const stream = createHeistStream({ projectName: "Vault" });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await tick();

    expect(observed?.aborted).toBe(true);
  });

  it("stops pulling from the generator once the client is gone", async () => {
    let produced = 0;

    streamHeistMessageMock.mockImplementation(async function* () {
      for (let i = 0; i < 50; i += 1) {
        produced += 1;
        yield { type: "chunk", text: `chunk-${i}` };
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      yield { type: "done", message: "finished" };
    });

    const reader = createHeistStream({ projectName: "Vault" }).getReader();
    await reader.read();
    await reader.cancel();

    const atCancel = produced;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // A couple more may be in flight, but it must not run to completion.
    expect(produced).toBeLessThan(50);
    expect(produced - atCancel).toBeLessThanOrEqual(2);
  });

  it("does not throw when the generator errors after the client disconnected", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "chunk", text: "one" };
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("upstream exploded");
    });

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const reader = createHeistStream({ projectName: "Vault" }).getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 40));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("surfaces an error event when the generator throws while the client is still connected", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "chunk", text: "one" };
      throw new Error("upstream exploded");
    });

    const events = await readAll(createHeistStream({ projectName: "Vault" }));

    expect(events.at(-1)).toEqual({ type: "error", message: "upstream exploded" });
  });

  it("closes immediately without calling the model when the request is already aborted", async () => {
    streamHeistMessageMock.mockImplementation(async function* () {
      yield { type: "done", message: "ok" };
    });

    const upstream = new AbortController();
    upstream.abort();

    const events = await readAll(createHeistStream({ projectName: "Vault" }, upstream.signal));

    expect(events).toEqual([]);
    expect(streamHeistMessageMock).not.toHaveBeenCalled();
  });

  it("aborts the generator when the upstream request signal fires", async () => {
    let observed: AbortSignal | undefined;

    streamHeistMessageMock.mockImplementation(async function* (
      _input: unknown,
      options: { signal?: AbortSignal },
    ) {
      observed = options.signal;
      yield { type: "chunk", text: "one" };
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield { type: "done", message: "ok" };
    });

    const upstream = new AbortController();
    const reader = createHeistStream({ projectName: "Vault" }, upstream.signal).getReader();
    await reader.read();

    upstream.abort();
    await tick();

    expect(observed?.aborted).toBe(true);
    await reader.cancel();
  });
});
