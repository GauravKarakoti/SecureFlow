// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { reducer, toast, useToast } from "./use-toast";

type State = Parameters<typeof reducer>[0];
type Toast = State["toasts"][number];

const t = (id: string, extra: Partial<Toast> = {}): Toast => ({ id, open: true, ...extra });

describe("toast reducer", () => {
  it("adds the newest toast first and keeps only TOAST_LIMIT (1) of them", () => {
    const state = reducer({ toasts: [t("1")] }, { type: "ADD_TOAST", toast: t("2") });
    expect(state.toasts.map((x) => x.id)).toEqual(["2"]);
  });

  it("updates only the toast with the matching id", () => {
    const state = reducer(
      { toasts: [t("1", { title: "old" }), t("2", { title: "other" })] },
      { type: "UPDATE_TOAST", toast: { id: "1", title: "new" } },
    );
    expect(state.toasts.map((x) => x.title)).toEqual(["new", "other"]);
  });

  it("dismisses one toast by id, or every toast without an id", () => {
    vi.useFakeTimers();
    const start = { toasts: [t("a"), t("b")] };

    const one = reducer(start, { type: "DISMISS_TOAST", toastId: "a" });
    expect(one.toasts.map((x) => x.open)).toEqual([false, true]);

    const all = reducer(start, { type: "DISMISS_TOAST" });
    expect(all.toasts.every((x) => x.open === false)).toBe(true);
    vi.useRealTimers();
  });

  it("removes one toast by id, or all of them without an id", () => {
    const start = { toasts: [t("a"), t("b")] };
    expect(reducer(start, { type: "REMOVE_TOAST", toastId: "a" }).toasts.map((x) => x.id)).toEqual([
      "b",
    ]);
    expect(reducer(start, { type: "REMOVE_TOAST" }).toasts).toEqual([]);
  });
});

describe("toast() and useToast()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes new toasts to mounted hooks and lets them be updated and dismissed", () => {
    const { result, unmount } = renderHook(() => useToast());

    let handle!: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ title: "Saved" });
    });
    expect(result.current.toasts[0]).toMatchObject({ id: handle.id, title: "Saved", open: true });

    act(() => handle.update({ id: handle.id, title: "Saved again" }));
    expect(result.current.toasts[0]!.title).toBe("Saved again");

    act(() => handle.dismiss());
    expect(result.current.toasts[0]!.open).toBe(false);

    unmount();
  });

  it("closing a toast through onOpenChange dismisses it, and it is removed after the delay", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useToast());

    act(() => {
      toast({ title: "Heads up" });
    });
    act(() => result.current.toasts[0]!.onOpenChange!(false));
    expect(result.current.toasts[0]!.open).toBe(false);

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(result.current.toasts).toEqual([]);

    unmount();
  });

  it("dismiss() from the hook without an id closes every toast", () => {
    const { result, unmount } = renderHook(() => useToast());
    act(() => {
      toast({ title: "one" });
    });
    act(() => result.current.dismiss());
    expect(result.current.toasts.every((x) => x.open === false)).toBe(true);
    unmount();
  });
});
