/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MembersPage from "./page";

let mockSession: any = { user: { id: "user-admin", roles: ["ADMIN"] } };
const mockRedirect = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mockGetInstallationMembers = vi.hoisted(() => vi.fn());

vi.mock("@/lib/actions/members", () => ({
  getInstallationMembers: mockGetInstallationMembers,
  updateMemberRole: vi.fn().mockResolvedValue({ success: true }),
}));

describe("MembersPage (#1922)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: "user-admin", roles: ["ADMIN"] } };
    mockGetInstallationMembers.mockResolvedValue([
      {
        id: "user-admin",
        name: "Admin User",
        email: "admin@example.com",
        codename: "shadow-admin",
        role: "ADMIN",
        roles: ["ADMIN"],
        repoCount: 5,
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "user-triager",
        name: "Triager User",
        email: "triager@example.com",
        codename: "code-triager",
        role: "TRIAGER",
        roles: ["TRIAGER"],
        repoCount: 2,
        createdAt: new Date("2026-02-01"),
      },
      {
        id: "user-viewer",
        name: "Viewer User",
        email: "viewer@example.com",
        codename: "auditor-viewer",
        role: "VIEWER",
        roles: ["VIEWER"],
        repoCount: 0,
        createdAt: new Date("2026-03-01"),
      },
    ]);
  });

  it("redirects to sign-in when session is not authenticated", async () => {
    mockSession = null;
    await MembersPage();
    expect(mockRedirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("renders member statistics and member entries for authenticated users", async () => {
    const page = await MembersPage();
    render(page);

    expect(screen.getByText("Team Members")).toBeInTheDocument();
    expect(screen.getByText("Total Members")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // total
    expect(screen.getAllByText("Admin User").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Triager User").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Viewer User").length).toBeGreaterThan(0);
  });
});
