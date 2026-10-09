/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTypewriter } from "./use-typewriter";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useTypewriter", () => {
  it("reveals the text one character per interval", () => {
    const { result } = renderHook(() => useTypewriter("Hey", 10));

    expect(result.current).toBe("");
    tick(10);
    expect(result.current).toBe("H");
    tick(20);
    expect(result.current).toBe("Hey");
    tick(100);
    expect(result.current).toBe("Hey");
  });

  it("keeps its place when the stream appends to the text", () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 10), {
      initialProps: { text: "Hello" as string | null },
    });
    tick(50);
    expect(result.current).toBe("Hello");

    rerender({ text: "Hello world" });
    tick(10);
    expect(result.current).toBe("Hello ");
  });

  it("starts over when the text is replaced rather than extended", () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 10), {
      initialProps: { text: "Hello world" as string | null },
    });
    tick(110);
    expect(result.current).toBe("Hello world");

    rerender({ text: "Bye" });
    tick(10);
    expect(result.current).toBe("B");
    tick(20);
    expect(result.current).toBe("Bye");
  });

  it("does not show the old text while a longer replacement types in", () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 10), {
      initialProps: { text: "abc" as string | null },
    });
    tick(30);

    rerender({ text: "xyz and more" });
    tick(10);
    expect(result.current).toBe("x");
  });

  it("clears when the text goes away and types the next text from the start", () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 10), {
      initialProps: { text: "First" as string | null },
    });
    tick(50);

    rerender({ text: null });
    expect(result.current).toBe("");
    tick(0);

    rerender({ text: "Next" });
    tick(10);
    expect(result.current).toBe("N");
  });
});
