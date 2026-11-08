/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRadioAudio } from "./use-radio-audio";

class MockAudioContext {
  state = "suspended";
  destination = {};
  resume = vi.fn(async () => {
    this.state = "running";
  });
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  close = vi.fn(async () => {});
  createAnalyser() {
    return { fftSize: 0, connect: vi.fn(), disconnect: vi.fn() };
  }
  createOscillator() {
    return {
      type: "",
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }
  get currentTime() {
    return 0;
  }
}

let lastContext: MockAudioContext | null = null;

beforeEach(() => {
  lastContext = null;
  vi.stubGlobal(
    "AudioContext",
    class extends MockAudioContext {
      constructor() {
        super();
        lastContext = this;
      }
    },
  );
  Object.defineProperty(window, "AudioContext", {
    value: (globalThis as unknown as { AudioContext: unknown }).AudioContext,
    configurable: true,
  });
});

describe("useRadioAudio", () => {
  it("is off by default and creates no AudioContext", () => {
    const { result } = renderHook(() => useRadioAudio());
    expect(result.current.enabled).toBe(false);
    expect(lastContext).toBeNull();
  });

  it("resumes the context on enable and suspends it on disable", async () => {
    const { result } = renderHook(() => useRadioAudio());

    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.enabled).toBe(true);
    expect(lastContext).not.toBeNull();
    expect(lastContext!.resume).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.enabled).toBe(false);
    // Regression: toggling off used to leave the AudioContext running.
    expect(lastContext!.suspend).toHaveBeenCalledTimes(1);
  });

  it("resumes the same context when toggled back on", async () => {
    const { result } = renderHook(() => useRadioAudio());

    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      await result.current.toggle();
    });

    expect(result.current.enabled).toBe(true);
    expect(lastContext!.resume).toHaveBeenCalledTimes(2);
  });
});
