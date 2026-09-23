import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

/** A deferred task, so a test can see which calls are in flight. */
function tracker() {
  let active = 0;
  let peak = 0;
  const started: number[] = [];

  const fn = async (value: number, index: number) => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    // Uneven delays, so completion order differs from input order.
    await new Promise((resolve) => setTimeout(resolve, (value % 3) * 2));
    active -= 1;
    return value * 10;
  };

  return { fn, peak: () => peak, started };
}

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` calls at once", async () => {
    const t = tracker();
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      t.fn,
    );
    expect(t.peak()).toBe(3);
    expect(t.started).toHaveLength(20);
  });

  it("returns results in input order whatever the completion order", async () => {
    const t = tracker();
    const results = await mapWithConcurrency([5, 1, 4, 2, 3], 2, t.fn);
    expect(results).toEqual([50, 10, 40, 20, 30]);
  });

  it("passes the index", async () => {
    expect(await mapWithConcurrency(["a", "b"], 2, async (item, i) => `${item}${i}`)).toEqual([
      "a0",
      "b1",
    ]);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    const t = tracker();
    await mapWithConcurrency([1, 2], 10, t.fn);
    expect(t.peak()).toBe(2);
  });

  it("treats a zero, negative or fractional limit as at least one", async () => {
    for (const limit of [0, -2, 0.5, Number.NaN]) {
      const t = tracker();
      await mapWithConcurrency([1, 2, 3], limit, t.fn);
      expect(t.peak()).toBe(1);
    }
  });

  it("rejects with the first error and starts no further calls", async () => {
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (value) => {
      started.push(value);
      if (value === 2) throw new Error("boom");
      return value;
    });

    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([0, 1, 2]);
  });
});
