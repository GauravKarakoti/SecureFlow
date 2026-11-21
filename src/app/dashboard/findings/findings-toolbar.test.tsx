/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FindingsToolbar from "./findings-toolbar";

let currentParams = new URLSearchParams();
const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/dashboard/findings",
  useSearchParams: () => currentParams,
}));

const options = {
  severities: ["CRITICAL", "HIGH"],
  types: ["SECRET", "VULNERABILITY"],
  repositories: [
    { id: "repo-1", fullName: "org/repo-1" },
    { id: "repo-2", fullName: "org/repo-2" },
  ],
};

function renderToolbar(customOptions = options, total = 10) {
  const view = render(<FindingsToolbar options={customOptions} total={total} />);
  /** Simulate the navigation `router.push` / browser back-forward would perform. */
  const navigate = (query: string) => {
    currentParams = new URLSearchParams(query);
    view.rerender(<FindingsToolbar options={customOptions} total={total} />);
  };
  return { ...view, navigate };
}

describe("FindingsToolbar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    push.mockClear();
    replace.mockClear();
    currentParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("search input and history synchronization", () => {
    it("keeps a trailing space the user typed after the debounced search is applied", () => {
      const { navigate } = renderToolbar();
      const input = screen.getByLabelText("Search findings");

      fireEvent.change(input, { target: { value: "api " } });
      act(() => {
        vi.advanceTimersByTime(350);
      });

      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/dashboard/findings?q=api", { scroll: false });

      navigate("q=api");

      expect(input).toHaveValue("api ");

      // Nothing further to apply: the URL already holds the trimmed term.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(push).toHaveBeenCalledTimes(1);
    });

    it("still follows the URL when the search changes elsewhere (e.g. back button)", () => {
      currentParams = new URLSearchParams("q=api");
      const { navigate } = renderToolbar();
      const input = screen.getByLabelText("Search findings");
      expect(input).toHaveValue("api");

      navigate("");

      expect(input).toHaveValue("");
    });
  });

  describe("restoring filters from URL on page load", () => {
    it("restores severity, status, search, and sort from URL", () => {
      currentParams = new URLSearchParams("severity=CRITICAL&status=OPEN&sort=severity&q=database");
      renderToolbar();

      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("CRITICAL");
      expect(screen.getByLabelText("Filter by triage status")).toHaveTextContent("Open");
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("Most severe first");
      expect(screen.getByLabelText("Search findings")).toHaveValue("database");
    });

    it("restores sort order for all valid options", () => {
      currentParams = new URLSearchParams("sort=file");
      const { navigate } = renderToolbar();
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("By file path");

      navigate("sort=oldest");
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("Oldest first");

      navigate("sort=newest");
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("Newest first");
    });
  });

  describe("handling unknown or invalid values with fallback to defaults", () => {
    it("falls back to default options without crashing when invalid values are in URL", () => {
      currentParams = new URLSearchParams(
        "severity=SUPER_UNKNOWN&status=BOGUS_STATUS&sort=INVALID_SORT&type=NOPE&from=not-a-date",
      );
      renderToolbar();

      // Severity falls back to "Any severity"
      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("Any severity");
      // Status falls back to "Any status"
      expect(screen.getByLabelText("Filter by triage status")).toHaveTextContent("Any status");
      // Sort falls back to "Newest first" (DEFAULT_SORT)
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("Newest first");
      // Type falls back to "Any type"
      expect(screen.getByLabelText("Filter by type")).toHaveTextContent("Any type");
      // Date input falls back to empty string
      expect(screen.getByLabelText("Filter from date")).toHaveValue("");
    });

    it("normalizes case-insensitive valid severities and statuses", () => {
      currentParams = new URLSearchParams("severity=critical&status=resolved");
      renderToolbar();

      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("CRITICAL");
      expect(screen.getByLabelText("Filter by triage status")).toHaveTextContent("Resolved");
    });
  });

  describe("browser back and forward button navigation", () => {
    it("synchronizes all controls when navigating back and forward between filter states", () => {
      const { navigate } = renderToolbar();

      // Initial clean state
      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("Any severity");
      expect(screen.getByLabelText("Search findings")).toHaveValue("");

      // User applied filters (pushed state 1)
      navigate("severity=HIGH&q=token");
      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("HIGH");
      expect(screen.getByLabelText("Search findings")).toHaveValue("token");

      // User changed sort and status (pushed state 2)
      navigate("severity=HIGH&status=DISMISSED&sort=severity&q=token");
      expect(screen.getByLabelText("Filter by triage status")).toHaveTextContent("Dismissed");
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("Most severe first");

      // User pressed Browser Back button -> returns to state 1
      navigate("severity=HIGH&q=token");
      expect(screen.getByLabelText("Filter by triage status")).toHaveTextContent("Any status");
      expect(screen.getByLabelText("Sort findings")).toHaveTextContent("Newest first");
      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("HIGH");
      expect(screen.getByLabelText("Search findings")).toHaveValue("token");

      // User pressed Browser Back button again -> returns to initial clean state
      navigate("");
      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("Any severity");
      expect(screen.getByLabelText("Search findings")).toHaveValue("");
    });
  });

  describe("Clear filters button", () => {
    it("is displayed when filters are active and clears filters when clicked", () => {
      currentParams = new URLSearchParams("severity=HIGH&q=secret&status=OPEN");
      const { navigate } = renderToolbar();

      const clearButton = screen.getByRole("button", { name: /clear filters/i });
      expect(clearButton).toBeInTheDocument();

      fireEvent.click(clearButton);

      // Verify router.push was called to update URL
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/dashboard/findings", { scroll: false });

      // Search draft is cleared immediately
      expect(screen.getByLabelText("Search findings")).toHaveValue("");

      // Simulate the URL navigation
      navigate("");
      expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Filter by severity")).toHaveTextContent("Any severity");
      expect(screen.getByLabelText("Filter by triage status")).toHaveTextContent("Any status");
    });

    it("is not displayed when no filters are active", () => {
      currentParams = new URLSearchParams();
      renderToolbar();

      expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
    });
  });

  describe("Expiry filter (#1890)", () => {
    it("renders expiry filter select with 'All expiry' by default", () => {
      renderToolbar();
      expect(screen.getByLabelText("Filter by expiry")).toHaveTextContent("All expiry");
    });

    it("displays 'Expiring in 14 days' when expiring=14d is in search params", () => {
      currentParams = new URLSearchParams("expiring=14d");
      renderToolbar();
      expect(screen.getByLabelText("Filter by expiry")).toHaveTextContent("Expiring in 14 days");
      expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
    });
  });
});
