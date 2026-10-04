/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FindingsToolbar from "./findings-toolbar";

let currentParams = new URLSearchParams();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/dashboard/findings",
  useSearchParams: () => currentParams,
}));

const options = { severities: [], types: [], repositories: [] };

function renderToolbar() {
  const view = render(<FindingsToolbar options={options} total={0} />);
  /** Simulate the navigation `router.replace` would have performed. */
  const navigate = (query: string) => {
    currentParams = new URLSearchParams(query);
    view.rerender(<FindingsToolbar options={options} total={0} />);
  };
  return { ...view, navigate };
}

describe("FindingsToolbar search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    replace.mockClear();
    currentParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a trailing space the user typed after the debounced search is applied", () => {
    const { navigate } = renderToolbar();
    const input = screen.getByLabelText("Search findings");

    fireEvent.change(input, { target: { value: "api " } });
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/dashboard/findings?q=api", { scroll: false });

    navigate("q=api");

    expect(input).toHaveValue("api ");

    // Nothing further to apply: the URL already holds the trimmed term.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("still follows the URL when the search changes elsewhere", () => {
    currentParams = new URLSearchParams("q=api");
    const { navigate } = renderToolbar();
    const input = screen.getByLabelText("Search findings");
    expect(input).toHaveValue("api");

    navigate("");

    expect(input).toHaveValue("");
  });
});
