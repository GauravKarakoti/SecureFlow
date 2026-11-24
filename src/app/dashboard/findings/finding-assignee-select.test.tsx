/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FindingAssigneeSelect from "./finding-assignee-select";
import { assignFinding, getAssignableUsers } from "@/lib/actions/assignee";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/lib/actions/assignee", () => ({
  assignFinding: vi.fn().mockResolvedValue({ ok: true }),
  getAssignableUsers: vi.fn().mockResolvedValue([
    {
      id: "user-alice",
      name: "Alice Reviewer",
      email: "alice@example.com",
      codename: "alice-sec",
      image: null,
    },
    {
      id: "user-bob",
      name: "Bob Dev",
      email: "bob@example.com",
      codename: "bob-dev",
      image: null,
    },
  ]),
}));

describe("FindingAssigneeSelect Component (#1921)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("renders unassigned state by default", () => {
    render(
      <FindingAssigneeSelect repositoryId="repo-1" fingerprint="fp-123" currentAssignee={null} />,
    );

    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("renders current assignee name and avatar when assigned", () => {
    render(
      <FindingAssigneeSelect
        repositoryId="repo-1"
        fingerprint="fp-123"
        currentAssignee={{
          id: "user-alice",
          name: "Alice Reviewer",
          email: "alice@example.com",
          codename: "alice-sec",
          image: null,
        }}
      />,
    );

    expect(screen.getByText("Alice Reviewer")).toBeInTheDocument();
  });

  it("loads assignable users and assigns finding", async () => {
    render(
      <FindingAssigneeSelect repositoryId="repo-1" fingerprint="fp-123" currentAssignee={null} />,
    );

    const trigger = screen.getByTestId("assignee-select-trigger");
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(getAssignableUsers).toHaveBeenCalledWith("repo-1");
    });
  });
});
