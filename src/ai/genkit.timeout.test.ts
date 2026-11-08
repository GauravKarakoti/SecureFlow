import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAiTimeout } from "./genkit";

describe("withAiTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.AI_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.AI_TIMEOUT_MS;
  });

  it("returns the operation result when it resolves in time", async () => {
    const result = await withAiTimeout(async () => "ok", { timeoutMs: 1000 });
    expect(result).toBe("ok");
  });

  it("rejects with APIConnectionTimeoutError when the deadline passes", async () => {
    // Operation ignores the abort signal and never settles.
    const promise = withAiTimeout(async () => new Promise(() => {}), { timeoutMs: 500 });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "APIConnectionTimeoutError",
    });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it("passes an AbortSignal that fires when the deadline passes", async () => {
    let aborted = false;
    const promise = withAiTimeout(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve("aborted-cleanly");
          });
        }),
      { timeoutMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).resolves.toBe("aborted-cleanly");
    expect(aborted).toBe(true);
  });

  it("invokes the fallback on timeout", async () => {
    const promise = withAiTimeout(async () => new Promise(() => {}), {
      timeoutMs: 500,
      fallback: async () => "fallback-value",
    });
    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).resolves.toBe("fallback-value");
  });

  it("does not invoke the fallback for non-timeout errors", async () => {
    const fallback = vi.fn();
    await expect(
      withAiTimeout(
        async () => {
          throw new Error("boom");
        },
        { timeoutMs: 5000, fallback },
      ),
    ).rejects.toThrow("boom");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("ignores invalid AI_TIMEOUT_MS values instead of firing immediately", async () => {
    // Regression: "-5000" is truthy, so setTimeout(-5000) fired instantly and
    // every AI operation rejected with a timeout.
    process.env.AI_TIMEOUT_MS = "-5000";
    const result = await withAiTimeout(async () => "ok");
    expect(result).toBe("ok");

    process.env.AI_TIMEOUT_MS = "not-a-number";
    const result2 = await withAiTimeout(async () => "ok");
    expect(result2).toBe("ok");
  });

  it("honours a valid AI_TIMEOUT_MS", async () => {
    process.env.AI_TIMEOUT_MS = "250";
    const promise = withAiTimeout(async () => new Promise(() => {}));
    const assertion = expect(promise).rejects.toMatchObject({
      name: "APIConnectionTimeoutError",
    });
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
  });
});
