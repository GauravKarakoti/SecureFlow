/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminSuppressionRulesPage, { metadata } from "./page";
import SuppressionRulesClient from "./suppression-rules-client";
import { renewSuppressionRuleAction, updateSuppressionRuleAction } from "./actions";
import type { SuppressionRuleWithStats } from "@/lib/suppression-rules/service";

vi.mock("./actions", () => ({
  createSuppressionRuleAction: vi.fn(),
  updateSuppressionRuleAction: vi.fn(),
  renewSuppressionRuleAction: vi.fn(),
  deleteSuppressionRuleAction: vi.fn(),
}));

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

    expect(
      screen.getByRole("heading", { level: 1, name: "Suppression Rules" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ignore test fixtures")).toBeInTheDocument();
    expect(screen.getByText("15 suppressed (30d)")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument(); // metric count
    expect(screen.getByText("All Repositories")).toBeInTheDocument();
    expect(screen.getByText("Create Suppression Rule")).toBeInTheDocument();
  });
});

describe("Suppression rule expiry controls", () => {
  const expiredRule: SuppressionRuleWithStats = {
    id: "rule-expired",
    name: "Expired test rule",
    description: null,
    scope: "ALL",
    repositoryIds: [],
    matchCategory: null,
    matchPolicy: null,
    pathGlob: null,
    reason: "Isolated test fixture",
    expiresAt: new Date("2000-01-01"),
    thirtyDaySuppressionCount: 4,
    createdById: null,
    createdAt: new Date("1999-01-01"),
    updatedAt: new Date("1999-01-01"),
  };

  it("shows expired rules separately and keeps renewal errors and retry inside the dialog", async () => {
    const user = userEvent.setup();
    const renewedRule = { ...expiredRule, expiresAt: new Date("2099-07-01") };
    vi.mocked(renewSuppressionRuleAction)
      .mockResolvedValueOnce({ error: "Refresh this rule and try again." })
      .mockResolvedValueOnce(renewedRule);
    render(<SuppressionRulesClient initialRules={[expiredRule]} repositories={[]} />);

    expect(screen.getByText("Expired", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("1 expired")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Expired test rule" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Renew Expired test rule" }));
    expect(screen.getByRole("dialog", { name: "Renew Suppression Rule" })).toBeInTheDocument();
    const date = screen.getByLabelText("New expiry date (UTC)");
    expect(date).toBeRequired();
    await user.type(date, "2099-07-01");
    await user.click(screen.getByRole("button", { name: "Renew Rule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh this rule and try again.");
    expect(date).toHaveValue("2099-07-01");

    await user.click(screen.getByRole("button", { name: "Renew Rule" }));
    expect(await screen.findByRole("status")).toHaveTextContent("renewed");
    expect(screen.getByText("0 expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Expired test rule" })).toBeInTheDocument();
    expect(screen.getByText("4 suppressed (30d)")).toBeInTheDocument();
    expect(renewSuppressionRuleAction).toHaveBeenLastCalledWith("rule-expired", "2099-07-01");
  });

  it("keeps a rejected active edit open and explains how to recover", async () => {
    const user = userEvent.setup();
    const expiresAt = new Date("2099-07-01");
    const activeRule = { ...expiredRule, name: "Active test rule", expiresAt };
    vi.mocked(updateSuppressionRuleAction).mockResolvedValueOnce({
      error: "This rule expired or changed. Refresh the list before editing it.",
    });
    render(<SuppressionRulesClient initialRules={[activeRule]} repositories={[]} />);

    await user.click(screen.getByRole("button", { name: "Edit Active test rule" }));
    await user.click(screen.getByRole("button", { name: "Update Rule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("expired or changed");
    expect(screen.getByRole("heading", { name: "Edit Suppression Rule" })).toBeInTheDocument();
    expect(updateSuppressionRuleAction).toHaveBeenLastCalledWith(
      activeRule.id,
      expect.objectContaining({ name: activeRule.name, expiresAt: undefined }),
      expiresAt,
    );
  });
});
