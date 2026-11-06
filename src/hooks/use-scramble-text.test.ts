/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrambleText } from "./use-scramble-text";

/**
 * A controllable requestAnimationFrame: callbacks are queued and only run
 * when `step()` advances the virtual clock, so animation progress is
 * deterministic.
 */
let pending: Map<number, FrameRequestCallback>;
let nextId: number;
let now: number;

beforeEach(() => {
  pending = new Map();
  nextId = 1;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    pending.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Advance the virtual clock and flush every queued animation frame once. */
function step(ms: number) {
  now += ms;
  const callbacks = [...pending.values()];
  pending.clear();
  act(() => {
    for (const cb of callbacks) cb(now);
  });
}

describe("useScrambleText", () => {
  it("renders `from` immediately without animating on mount", () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useScrambleText({ from: "CODE", to: "NAME", isRevealing: false, onComplete }),
    );
    expect(result.current).toBe("CODE");
    expect(pending.size).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("settles on `to` and fires onComplete exactly once when revealing", () => {
    const onComplete = vi.fn();
    const { result, rerender } = renderHook(
      ({ isRevealing }) =>
        useScrambleText({ from: "CODE", to: "NAME", isRevealing, duration: 400, onComplete }),
      { initialProps: { isRevealing: false } },
    );

    rerender({ isRevealing: true });
    step(16); // first frame: start timestamp, progress 0 — all scrambled
    expect(result.current).toHaveLength(4);

    step(400);
    expect(result.current).toBe("NAME");
    expect(onComplete).toHaveBeenCalledTimes(1);

    step(100); // no further frames are scheduled
    expect(result.current).toBe("NAME");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("locks characters left-to-right as progress advances", () => {
    const { result, rerender } = renderHook(
      ({ isRevealing }) =>
        useScrambleText({ from: "AAAA", to: "BBBB", isRevealing, duration: 400 }),
      { initialProps: { isRevealing: false } },
    );

    rerender({ isRevealing: true });
    step(16); // start frame
    step(200); // progress 0.5 → half the characters locked
    expect(result.current.slice(0, 2)).toBe("BB");
    expect(result.current).toHaveLength(4);
  });

  it("scrambles back to `from` when isRevealing flips again", () => {
    const { result, rerender } = renderHook(
      ({ isRevealing }) =>
        useScrambleText({ from: "CODE", to: "NAME", isRevealing, duration: 400 }),
      { initialProps: { isRevealing: false } },
    );

    rerender({ isRevealing: true });
    step(16);
    step(400);
    expect(result.current).toBe("NAME");

    rerender({ isRevealing: false });
    step(16);
    step(400);
    expect(result.current).toBe("CODE");
  });

  it("uses the latest onComplete via the ref, without restarting the animation", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ isRevealing, onComplete }) =>
        useScrambleText({ from: "CODE", to: "NAME", isRevealing, duration: 400, onComplete }),
      { initialProps: { isRevealing: false, onComplete: first } },
    );

    rerender({ isRevealing: true, onComplete: first });
    step(16);
    rerender({ isRevealing: true, onComplete: second }); // swap callback mid-animation
    step(400);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels the in-flight frame on unmount", () => {
    const { rerender, unmount } = renderHook(
      ({ isRevealing }) =>
        useScrambleText({ from: "CODE", to: "NAME", isRevealing, duration: 400 }),
      { initialProps: { isRevealing: false } },
    );

    rerender({ isRevealing: true });
    step(16);
    expect(pending.size).toBe(1);

    unmount();
    expect(pending.size).toBe(0);
  });
});
