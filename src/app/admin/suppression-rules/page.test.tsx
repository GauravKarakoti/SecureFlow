/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminSuppressionRulesPage, { metadata } from "./page";

vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "admin-1", email: "admin@example.com", roles: ["ADMIN"] },
  }),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: {
      findMany: vi.fn().mockResolvedValue([
        { id: "repo-1", fullName: "org/repo-a" },
        { id: "repo-2", fullName: "org/repo-b" },
      ]),
    },
  },
}));

vi.mock("@/lib/suppression-rules/service", () => ({
  getSuppressionRulesWithStats: vi.fn().mockResolvedValue([
    {
      id: "rule-1",
      name: "Ignore test fixtures",
      description: "Dummy test fixtures",
      scope: "ALL",
      repositoryIds: [],
      matchCategory: "SECRET",
      matchPolicy: null,
      pathGlob: "fixtures/**",
      reason: "Mock credentials",
      expiresAt: null,
      thirtyDaySuppressionCount: 15,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]),
}));

describe("AdminSuppressionRulesPage Component (#1891)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports appropriate metadata", () => {
    expect(metadata.title).toContain("Suppression Rules");
  });

  it("renders page header and suppression rules list", async () => {
    const page = await AdminSuppressionRulesPage();
    render(page);

    expect(screen.getByRole("heading", { level: 1, name: "Suppression Rules" })).toBeInTheDocument();
    expect(screen.getByText("Ignore test fixtures")).toBeInTheDocument();
    expect(screen.getByText("15 suppressed (30d)")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument(); // metric count
    expect(screen.getByText("All Repositories")).toBeInTheDocument();
    expect(screen.getByText("Create Suppression Rule")).toBeInTheDocument();
  });
});
