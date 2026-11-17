/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SavedViewsControl from "./saved-views-control";
import * as actions from "@/lib/actions/saved-views";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/dashboard/findings",
}));

vi.mock("@/lib/actions/saved-views", async () => {
  const actual = await vi.importActual<typeof actions>("@/lib/actions/saved-views");
  return {
    ...actual,
    createSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
  };
});

describe("SavedViewsControl Component (#1786)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockViews = [
    {
      id: "view-1",
      userId: "user-1",
      name: "Critical Secrets",
      filters: { severity: ["CRITICAL"], type: ["SECRET"] },
      createdAt: new Date("2026-11-01"),
      updatedAt: new Date("2026-11-01"),
    },
    {
      id: "view-2",
      userId: "user-1",
      name: "Open Vulnerabilities Repo X",
      filters: { status: ["OPEN"], repositoryId: "repo-x", from: "2026-11-01", to: "2026-11-15" },
      createdAt: new Date("2026-11-05"),
      updatedAt: new Date("2026-11-05"),
    },
  ];

  it("renders the Saved views trigger with badge count", () => {
    render(<SavedViewsControl initialViews={mockViews} currentFilters={{}} />);

    expect(screen.getByRole("button", { name: /saved views/i })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("opens dropdown and lists saved views", () => {
    render(<SavedViewsControl initialViews={mockViews} currentFilters={{}} />);

    const trigger = screen.getByRole("button", { name: /saved views/i });
    fireEvent.click(trigger);

    expect(screen.getByText("Critical Secrets")).toBeInTheDocument();
    expect(screen.getByText("Open Vulnerabilities Repo X")).toBeInTheDocument();
  });

  it("applies a saved view's filters to the URL on click", () => {
    render(<SavedViewsControl initialViews={mockViews} currentFilters={{}} />);

    fireEvent.click(screen.getByRole("button", { name: /saved views/i }));
    fireEvent.click(screen.getByText("Critical Secrets"));

    expect(replace).toHaveBeenCalledWith(
      expect.stringContaining("severity=CRITICAL&type=SECRET"),
      { scroll: false },
    );
  });

  it("calls deleteSavedView when delete icon is clicked", async () => {
    vi.mocked(actions.deleteSavedView).mockResolvedValue({ success: true });

    render(<SavedViewsControl initialViews={mockViews} currentFilters={{}} />);

    fireEvent.click(screen.getByRole("button", { name: /saved views/i }));
    const deleteBtn = screen.getByLabelText("Delete saved view Critical Secrets");
    fireEvent.click(deleteBtn);

    expect(actions.deleteSavedView).toHaveBeenCalledWith("view-1");
    await waitFor(() => {
      expect(screen.queryByText("Critical Secrets")).not.toBeInTheDocument();
    });
  });

  it("opens Save View dialog and creates a saved view with current active filters", async () => {
    const activeFilters = {
      severity: ["HIGH"],
      status: ["OPEN"],
      repositoryId: "repo-9",
    };

    const newSavedView = {
      id: "view-3",
      userId: "user-1",
      name: "High Priority Queue",
      filters: activeFilters,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(actions.createSavedView).mockResolvedValue(newSavedView);

    render(<SavedViewsControl initialViews={mockViews} currentFilters={activeFilters} />);

    // Click "Save view" trigger
    fireEvent.click(screen.getByRole("button", { name: /save current view/i }));

    expect(screen.getByText("Save Current View")).toBeInTheDocument();

    const input = screen.getByLabelText("View name");
    fireEvent.change(input, { target: { value: "High Priority Queue" } });

    // Submit dialog
    const saveSubmitBtn = screen.getByRole("button", { name: "Save view" });
    fireEvent.click(saveSubmitBtn);

    await waitFor(() => {
      expect(actions.createSavedView).toHaveBeenCalledWith({
        name: "High Priority Queue",
        filters: activeFilters,
      });
    });
  });

  it("shows an empty message when there are no saved views", () => {
    render(<SavedViewsControl initialViews={[]} currentFilters={{}} />);

    fireEvent.click(screen.getByRole("button", { name: /saved views/i }));
    expect(screen.getByText(/no saved views yet/i)).toBeInTheDocument();
  });
});
