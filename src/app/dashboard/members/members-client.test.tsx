/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MembersClient from "./members-client";
import { updateMemberRole } from "@/lib/actions/members";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/lib/actions/members", () => ({
  updateMemberRole: vi.fn().mockResolvedValue({ success: true }),
}));

const SAMPLE_MEMBERS = [
  {
    id: "user-admin",
    name: "Admin Alice",
    email: "alice@example.com",
    codename: "alice-cyber",
    image: null,
    role: "ADMIN" as const,
    roles: ["ADMIN"],
    repoCount: 3,
    createdAt: new Date("2026-01-01"),
  },
  {
    id: "user-triager",
    name: "Triager Bob",
    email: "bob@example.com",
    codename: "bob-triage",
    image: null,
    role: "TRIAGER" as const,
    roles: ["TRIAGER"],
    repoCount: 1,
    createdAt: new Date("2026-01-10"),
  },
  {
    id: "user-viewer",
    name: "Viewer Charlie",
    email: "charlie@example.com",
    codename: "charlie-view",
    image: null,
    role: "VIEWER" as const,
    roles: ["VIEWER"],
    repoCount: 0,
    createdAt: new Date("2026-01-20"),
  },
];

describe("MembersClient Component (#1922)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the members list on both desktop and mobile viewports", () => {
    render(<MembersClient members={SAMPLE_MEMBERS} canManage={true} currentUserId="user-admin" />);

    expect(screen.getAllByText("Admin Alice").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Triager Bob").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Viewer Charlie").length).toBeGreaterThan(0);
  });

  it("filters members by search query", () => {
    render(<MembersClient members={SAMPLE_MEMBERS} canManage={true} currentUserId="user-admin" />);

    const searchInput = screen.getByTestId("members-search-input");
    fireEvent.change(searchInput, { target: { value: "bob" } });

    expect(screen.queryByText("Admin Alice")).not.toBeInTheDocument();
    expect(screen.getAllByText("Triager Bob").length).toBeGreaterThan(0);
    expect(screen.queryByText("Viewer Charlie")).not.toBeInTheDocument();
  });

  it("filters members by role dropdown", () => {
    render(<MembersClient members={SAMPLE_MEMBERS} canManage={true} currentUserId="user-admin" />);

    const roleFilter = screen.getByTestId("members-role-filter");
    fireEvent.change(roleFilter, { target: { value: "VIEWER" } });

    expect(screen.queryByText("Admin Alice")).not.toBeInTheDocument();
    expect(screen.queryByText("Triager Bob")).not.toBeInTheDocument();
    expect(screen.getAllByText("Viewer Charlie").length).toBeGreaterThan(0);
  });

  it("allows admin to change member role and calls updateMemberRole", async () => {
    render(<MembersClient members={SAMPLE_MEMBERS} canManage={true} currentUserId="user-admin" />);

    const select = screen.getByTestId("select-role-user-triager");
    fireEvent.change(select, { target: { value: "VIEWER" } });

    await waitFor(() => {
      expect(updateMemberRole).toHaveBeenCalledWith("user-triager", "VIEWER");
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Role updated",
        }),
      );
    });
  });

  it("disables role selection for self-admin to prevent self-demotion in UI", () => {
    render(<MembersClient members={SAMPLE_MEMBERS} canManage={true} currentUserId="user-admin" />);

    const adminSelect = screen.getByTestId("select-role-user-admin");
    expect(adminSelect).toBeDisabled();
  });

  it("renders read-only view and hides role select controls when canManage is false", () => {
    render(
      <MembersClient members={SAMPLE_MEMBERS} canManage={false} currentUserId="user-viewer" />,
    );

    expect(screen.queryByTestId("select-role-user-triager")).not.toBeInTheDocument();
    expect(screen.getAllByText("Read-only").length).toBeGreaterThan(0);
  });
});
