/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import PoliciesPage from "./page";
import PoliciesLoading from "./loading";
import * as authModule from "@/auth";
import prisma from "@/lib/prisma";
import { ArmorIQService } from "@/lib/armor/iq";
import { redirect } from "next/navigation";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    policyTemplate: {
      findMany: vi.fn(),
    },
    userPolicyToggle: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/armor/iq", () => ({
  ArmorIQService: {
    getClient: vi.fn(),
    isConfigured: vi.fn(),
    compileToArmorIQPolicy: vi.fn(),
  },
}));

vi.mock("./policy-card", () => ({
  PolicyCard: ({
    id,
    title,
    description,
    isActive,
    severity,
    action,
    rules,
  }: {
    id: string;
    title: string;
    description: string;
    isActive: boolean;
    severity: string;
    action: string;
    rules: any[];
  }) => (
    <div data-testid={`policy-card-${id}`}>
      <span data-testid={`policy-title-${id}`}>{title}</span>
      <span data-testid={`policy-desc-${id}`}>{description}</span>
      <span data-testid={`policy-active-${id}`}>{isActive ? "active" : "inactive"}</span>
      <span data-testid={`policy-severity-${id}`}>{severity}</span>
      <span data-testid={`policy-action-${id}`}>{action}</span>
      <span data-testid={`policy-rules-count-${id}`}>{rules.length}</span>
    </div>
  ),
}));

vi.mock("./actions", () => ({
  togglePolicy: vi.fn(),
}));

describe("PoliciesPage Server Component", () => {
  const mockTemplates = [
    {
      id: "policy-1",
      name: "Enforce HTTPS Only",
      description: "Block all unencrypted HTTP egress calls.",
      severity: "HIGH",
      action: "BLOCK",
      isDefault: true,
      rules: { conditions: [{ type: "protocol", value: "https" }] },
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "policy-2",
      name: "Secret Redaction Enforcement",
      description: "Prevent commits containing unredacted API tokens.",
      severity: "CRITICAL",
      action: "BLOCK",
      isDefault: false,
      rules: [{ type: "regex", value: "ghp_" }],
      createdAt: new Date("2026-01-02"),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to signin page", async () => {
    vi.mocked(authModule.auth).mockResolvedValueOnce(null as any);

    await expect(PoliciesPage()).rejects.toThrow("REDIRECT:/api/auth/signin");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("redirects users missing email in session", async () => {
    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-1" },
    } as any);

    await expect(PoliciesPage()).rejects.toThrow("REDIRECT:/api/auth/signin");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it("renders policies with active state matching user policy toggles", async () => {
    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-1", email: "secops@secureflow.io" },
    } as any);

    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValueOnce(mockTemplates as any);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValueOnce([
      { policyTemplateId: "policy-1", isActive: false },
      { policyTemplateId: "policy-2", isActive: true },
    ] as any);

    vi.mocked(ArmorIQService.getClient).mockReturnValue(null);
    vi.mocked(ArmorIQService.isConfigured).mockReturnValue(true);
    vi.mocked(ArmorIQService.compileToArmorIQPolicy).mockReturnValue({
      rulesCount: 1,
      targetScope: "secops@secureflow.io",
    } as any);

    const jsx = await PoliciesPage();
    render(jsx);

    expect(screen.getByText("The Rules")).toBeInTheDocument();
    expect(screen.getByText("Programmatic Rule Set")).toBeInTheDocument();
    expect(screen.getByText("secops@secureflow.io")).toBeInTheDocument();

    // Policy 1 was default true, but user toggled to false
    expect(screen.getByTestId("policy-card-policy-1")).toBeInTheDocument();
    expect(screen.getByTestId("policy-active-policy-1")).toHaveTextContent("inactive");

    // Policy 2 was default false, but user toggled to true
    expect(screen.getByTestId("policy-card-policy-2")).toBeInTheDocument();
    expect(screen.getByTestId("policy-active-policy-2")).toHaveTextContent("active");

    // Check rules count
    expect(screen.getByTestId("policy-rules-count-policy-1")).toHaveTextContent("1");
    expect(screen.getByTestId("policy-rules-count-policy-2")).toHaveTextContent("1");
  });

  it("falls back to template.isDefault when no user policy toggle exists", async () => {
    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-2", email: "developer@secureflow.io" },
    } as any);

    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValueOnce(mockTemplates as any);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValueOnce([] as any);

    vi.mocked(ArmorIQService.getClient).mockReturnValue(null);
    vi.mocked(ArmorIQService.isConfigured).mockReturnValue(true);
    vi.mocked(ArmorIQService.compileToArmorIQPolicy).mockReturnValue({} as any);

    const jsx = await PoliciesPage();
    render(jsx);

    // policy-1 isDefault = true
    expect(screen.getByTestId("policy-active-policy-1")).toHaveTextContent("active");
    // policy-2 isDefault = false
    expect(screen.getByTestId("policy-active-policy-2")).toHaveTextContent("inactive");
  });

  it("displays ArmorIQ cloud configuration warning when ARMORIQ_API_KEY is not configured", async () => {
    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-3", email: "admin@secureflow.io" },
    } as any);

    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValueOnce(mockTemplates as any);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValueOnce([] as any);

    vi.mocked(ArmorIQService.getClient).mockReturnValue(null);
    vi.mocked(ArmorIQService.isConfigured).mockReturnValue(false);
    vi.mocked(ArmorIQService.compileToArmorIQPolicy).mockReturnValue({} as any);

    const jsx = await PoliciesPage();
    render(jsx);

    expect(screen.getByText(/ArmorIQ cloud enforcement is inactive/i)).toBeInTheDocument();
  });

  it("renders empty state message when no policy templates are found", async () => {
    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-4", email: "dev@secureflow.io" },
    } as any);

    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValueOnce([] as any);

    vi.mocked(ArmorIQService.getClient).mockReturnValue(null);
    vi.mocked(ArmorIQService.isConfigured).mockReturnValue(true);
    vi.mocked(ArmorIQService.compileToArmorIQPolicy).mockReturnValue({} as any);

    const jsx = await PoliciesPage();
    render(jsx);

    expect(
      screen.getByText(
        /No rule templates available\. \(Administrators need to seed the database\)\./i,
      ),
    ).toBeInTheDocument();
  });

  it("handles complex JSON rules arrays and object conditions accurately", async () => {
    const complexTemplates = [
      {
        id: "policy-complex",
        name: "Custom OWASP Advanced Guard",
        description: "Enforces advanced sanitization and header security",
        category: "OWASP",
        rules: [
          { ruleId: "R1", condition: "input_sanitized", action: "block" },
          { ruleId: "R2", condition: "strict_transport_security", action: "warn" },
          { ruleId: "R3", condition: "content_security_policy", action: "audit" },
        ],
        isDefault: true,
      },
      {
        id: "policy-conditions-object",
        name: "Object With Conditions Array Policy",
        description: "Policy with { conditions: [...] } structure",
        category: "Custom",
        rules: {
          conditions: [
            { ruleId: "COND_1", pattern: "bearer_token" },
            { ruleId: "COND_2", pattern: "jwt_signature" },
          ],
        },
        isDefault: false,
      },
    ];

    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-5", email: "secops-lead@secureflow.io" },
    } as any);

    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValueOnce(complexTemplates as any);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValueOnce([] as any);

    vi.mocked(ArmorIQService.getClient).mockReturnValue(null);
    vi.mocked(ArmorIQService.isConfigured).mockReturnValue(true);
    vi.mocked(ArmorIQService.compileToArmorIQPolicy).mockReturnValue({} as any);

    const jsx = await PoliciesPage();
    render(jsx);

    expect(screen.getByTestId("policy-card-policy-complex")).toBeInTheDocument();
    expect(screen.getByTestId("policy-rules-count-policy-complex")).toHaveTextContent("3");
    expect(screen.getByTestId("policy-card-policy-conditions-object")).toBeInTheDocument();
    expect(screen.getByTestId("policy-rules-count-policy-conditions-object")).toHaveTextContent(
      "2",
    );
  });

  it("handles empty or non-array rules object gracefully without crashing", async () => {
    const fallbackTemplate = [
      {
        id: "policy-empty-rules",
        name: "Empty Rules Policy",
        description: "Policy containing rules without conditions",
        category: "Experimental",
        rules: {} as any,
        isDefault: false,
      },
    ];

    vi.mocked(authModule.auth).mockResolvedValueOnce({
      user: { id: "user-6", email: "qa@secureflow.io" },
    } as any);

    vi.mocked(prisma.policyTemplate.findMany).mockResolvedValueOnce(fallbackTemplate as any);
    vi.mocked(prisma.userPolicyToggle.findMany).mockResolvedValueOnce([] as any);

    vi.mocked(ArmorIQService.getClient).mockReturnValue(null);
    vi.mocked(ArmorIQService.isConfigured).mockReturnValue(true);
    vi.mocked(ArmorIQService.compileToArmorIQPolicy).mockReturnValue({} as any);

    const jsx = await PoliciesPage();
    render(jsx);

    expect(screen.getByTestId("policy-card-policy-empty-rules")).toBeInTheDocument();
    expect(screen.getByTestId("policy-rules-count-policy-empty-rules")).toHaveTextContent("0");
  });
});

describe("PoliciesLoading Skeleton Component", () => {
  it("renders full loading skeleton elements matching layout structure", () => {
    const { container } = render(<PoliciesLoading />);

    expect(screen.getByTestId("policies-loading")).toBeInTheDocument();
    expect(screen.getByTestId("policies-summary-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("policies-grid-skeleton")).toBeInTheDocument();

    // Check individual card skeletons
    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`policy-card-skeleton-${i}`)).toBeInTheDocument();
    }

    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(15);
  });

  it("has accessible attributes for screen readers", () => {
    render(<PoliciesLoading />);
    const loadingContainer = screen.getByRole("status");
    expect(loadingContainer).toBeInTheDocument();
    expect(loadingContainer).toHaveAttribute(
      "aria-label",
      "Loading security policies and programmatic rules",
    );
  });
});
