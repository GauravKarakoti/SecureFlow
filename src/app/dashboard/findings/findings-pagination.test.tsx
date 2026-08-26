/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FindingsPagination from "./findings-pagination";

const replace = vi.fn();
let currentParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/dashboard/findings",
  useSearchParams: () => currentParams,
}));

describe("FindingsPagination", () => {
  beforeEach(() => {
    replace.mockClear();
    currentParams = new URLSearchParams();
  });

  it("renders nothing when there is nothing to page through", () => {
    const { container } = render(
      <FindingsPagination page={1} pageSize={20} total={0} totalPages={1} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("reports the row range for the current page", () => {
    render(<FindingsPagination page={2} pageSize={20} total={57} totalPages={3} />);

    const range = screen.getByTestId("findings-pagination").textContent ?? "";
    expect(range).toContain("21");
    expect(range).toContain("40");
    expect(range).toContain("57");
  });

  it("clamps the last row number to the total on a partial final page", () => {
    render(<FindingsPagination page={3} pageSize={20} total={57} totalPages={3} />);

    const range = screen.getByTestId("findings-pagination").textContent ?? "";
    expect(range).toContain("41");
    expect(range).toContain("57");
    expect(range).not.toContain("60");
  });

  it("disables Previous on the first page and Next on the last", () => {
    const { rerender } = render(
      <FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />
    );
    expect(screen.getByRole("button", { name: /previous page/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next page/i })).not.toBeDisabled();

    rerender(<FindingsPagination page={3} pageSize={20} total={57} totalPages={3} />);
    expect(screen.getByRole("button", { name: /previous page/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /next page/i })).toBeDisabled();
  });

  it("gives a disabled button a not-allowed cursor", () => {
    // `Button` sets `disabled:pointer-events-none`, so a cursor rule on the
    // button itself never fires — the pointer stays a plain arrow and the
    // control reads as clickable. The cursor has to sit on an ancestor that
    // still accepts pointer events.
    render(<FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />);

    const previous = screen.getByRole("button", { name: /previous page/i });
    const next = screen.getByRole("button", { name: /next page/i });

    expect(previous.parentElement?.className).toContain("cursor-not-allowed");
    expect(next.parentElement?.className).not.toContain("cursor-not-allowed");
  });

  it("dulls the affordances of a disabled button, not just its opacity", () => {
    // opacity-50 alone leaves a crisp border and a crisp label, which still
    // read as clickable on the outline variant.
    render(<FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />);

    const previous = screen.getByRole("button", { name: /previous page/i });

    expect(previous.className).toContain("disabled:border-foreground/10");
    expect(previous.className).toContain("disabled:text-muted-foreground");
    expect(previous.className).toContain("disabled:opacity-40");
  });

  it("does not navigate when a disabled button is clicked", () => {
    render(<FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />);

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));

    expect(replace).not.toHaveBeenCalled();
  });

  it("writes the page number into the URL", () => {
    render(<FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />);

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));

    expect(replace).toHaveBeenCalledWith("/dashboard/findings?page=2", { scroll: false });
  });

  it("preserves the active filters when paging", () => {
    // Paging must not silently drop the filter the reader is looking at.
    currentParams = new URLSearchParams("severity=CRITICAL&q=aws");
    render(<FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />);

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));

    const [url] = replace.mock.calls[0];
    expect(url).toContain("severity=CRITICAL");
    expect(url).toContain("q=aws");
    expect(url).toContain("page=2");
  });

  it("drops page=1 from the URL rather than writing the default", () => {
    currentParams = new URLSearchParams("page=2");
    render(<FindingsPagination page={2} pageSize={20} total={57} totalPages={3} />);

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));

    expect(replace).toHaveBeenCalledWith("/dashboard/findings", { scroll: false });
  });

  it("exposes itself as a labelled navigation landmark", () => {
    render(<FindingsPagination page={1} pageSize={20} total={57} totalPages={3} />);

    expect(screen.getByRole("navigation", { name: /findings pagination/i })).toBeInTheDocument();
  });
});
