import { describe, it, expect, vi } from "vitest";
import UsersTable from "./UsersTable";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

// Mock server actions
vi.mock("@/lib/actions/admin", () => ({
  updateUserRole: vi.fn(),
  deleteUser: vi.fn(),
}));

// Mock useToast
const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}));

describe("UsersTable component", () => {
  it("should be defined and export a valid React component", () => {
    expect(UsersTable).toBeDefined();
    expect(typeof UsersTable).toBe("function");
  });
});
