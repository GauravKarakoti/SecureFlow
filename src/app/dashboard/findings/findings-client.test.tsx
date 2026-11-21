/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import FindingsClient from "./findings-client";

let currentParams = new URLSearchParams();

// Mock Next.js app router hooks
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/dashboard/findings",
  useSearchParams: () => currentParams,
}));

// Mock react-countup
vi.mock("react-countup", () => ({
  default: ({ end }: { end: number }) => <span>{end}</span>,
}));

// Mock streaming-explanation component
vi.mock("@/components/streaming-explanation", () => ({
  default: () => <div data-testid="streaming-explanation">Explanation</div>,
}));

// Mock triage controls
vi.mock("./finding-triage-controls", () => ({
  default: () => <div data-testid="triage-controls">Triage Controls</div>,
}));

// Mock BulkRemediationBar to avoid "Cannot read properties of undefined (reading 'length')"
// when FindingsClient renders it without an active selection in standard tests.
vi.mock("./bulk-remediation-bar", () => ({
  default: () => <div data-testid="bulk-remediation-bar-mock" />,
}));

describe("FindingsClient Component (#633)", () => {
  const mockStats = {
    criticalSecrets: 4,
    vulnerabilities: 9,
    misconfigs: 2,
    other: 0,
  };

  // Cast to any[] to bypass the strict FindingRow interface requirements
  const mockFindings: any[] = [
    {
      id: "f-1",
      type: "SECRET",
      severity: "CRITICAL",
      fileLocation: "src/config/keys.ts",
      codeSnippet: "API_SECRET = '123'",
      explanation: "Hardcoded secret leak.",
      remediation: "Rotate key.",
      promptInjectionSuspected: false,
      repositoryId: "repo-1",
      fingerprint: "fp-1",
      triageStatus: "OPEN",
    },
    {
      id: "f-2",
      type: "VULNERABILITY",
      severity: "HIGH",
      fileLocation: "src/auth/token.ts",
      codeSnippet: "jwt.decode(token)",
      explanation: "Unverified token payload.",
      remediation: "Verify signature.",
      promptInjectionSuspected: true,
      repositoryId: "repo-1",
      fingerprint: "fp-2",
      triageStatus: "RESOLVED",
    },
  ];

  // Base props structured for reuse across tests
  const defaultProps = {
    findings: mockFindings,
    stats: mockStats,
    total: 2,
    page: 1,
    pageSize: 50,
    totalPages: 1,
    filterOptions: { repositories: [], types: [], severities: [] },
  };

  it("renders stat boxes with correct values", () => {
    render(<FindingsClient {...defaultProps} />);

    expect(screen.getByText("Security Findings")).toBeInTheDocument();
    expect(screen.getByText("Critical Secrets")).toBeInTheDocument();
    expect(screen.getByText("Vulnerabilities")).toBeInTheDocument();
    expect(screen.getByText("Misconfigs")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("2 Findings")).toBeInTheDocument();
  });

  it("renders finding items and handles prompt injection and triage badges", () => {
    render(<FindingsClient {...defaultProps} />);

    expect(screen.getByText("SECRET Detected")).toBeInTheDocument();
    expect(screen.getByText("VULNERABILITY Detected")).toBeInTheDocument();
    expect(screen.getByText("src/config/keys.ts")).toBeInTheDocument();
    expect(screen.getByText("src/auth/token.ts")).toBeInTheDocument();

    expect(screen.getByText("⚠️ Verify manually")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("links each finding to its permalink detail page", () => {
    render(<FindingsClient {...defaultProps} />);

    const link1 = screen.getByRole("link", { name: "View finding f-1 details" });
    expect(link1).toHaveAttribute("href", "/dashboard/findings/f-1");

    const link2 = screen.getByRole("link", { name: "View finding f-2 details" });
    expect(link2).toHaveAttribute("href", "/dashboard/findings/f-2");
  });

  it("renders empty state when findings array is empty", () => {
    render(
      <FindingsClient
        {...defaultProps}
        findings={[]}
        total={0}
        stats={{ ...mockStats, criticalSecrets: 0, vulnerabilities: 0, misconfigs: 0 }}
      />,
    );

    expect(screen.getByText("No Security Findings")).toBeInTheDocument();
    expect(
      screen.getByText("Great news! Your repositories are currently secure."),
    ).toBeInTheDocument();
  });

  it("links Export CSV to the server export with the current filters, minus paging", () => {
    // The export must cover the filtered total, not the page in the browser.
    currentParams = new URLSearchParams("severity=CRITICAL&q=token&page=3&pageSize=100");
    try {
      render(<FindingsClient {...defaultProps} total={340} />);
      const link = screen.getByRole("link", { name: /Export CSV/ });
      expect(link).toHaveAttribute("href", "/api/findings/export?severity=CRITICAL&q=token");
      expect(link).toHaveAttribute("download");
    } finally {
      currentParams = new URLSearchParams();
    }
  });

  it("disables Export CSV when nothing matches", () => {
    render(<FindingsClient {...defaultProps} findings={[]} total={0} />);
    expect(screen.getByRole("button", { name: /Export CSV/ })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Export CSV/ })).toBeNull();
  });

  it("renders themed Heist Risk Score and Vault Integrity Status metrics (#1711)", () => {
    render(<FindingsClient {...defaultProps} />);
    expect(screen.getByText("Heist Risk Score")).toBeInTheDocument();
    expect(screen.getByText("Vault Integrity Status")).toBeInTheDocument();
  });

  it("links Shareable Report to the HTML report export with active query filters", () => {
    currentParams = new URLSearchParams("severity=CRITICAL&q=token");
    try {
      render(<FindingsClient {...defaultProps} total={12} />);
      const link = screen.getByRole("link", { name: /Shareable Report/ });
      expect(link).toHaveAttribute(
        "href",
        "/api/findings/export?severity=CRITICAL&q=token&format=html",
      );
      expect(link).toHaveAttribute("target", "_blank");
    } finally {
      currentParams = new URLSearchParams();
    }
  });

  it("renders 'resolved by commit abc1234' badge when finding is resolved (#1869)", () => {
    const resolvedFinding: any = {
      id: "f-resolved",
      type: "SECRET",
      severity: "HIGH",
      fileLocation: "src/auth/token.ts",
      codeSnippet: "API_KEY = 'secret'",
      explanation: "Hardcoded secret.",
      remediation: "Move to env.",
      promptInjectionSuspected: false,
      fingerprint: "fp-res-1",
      createdAt: new Date("2026-11-18T10:00:00Z"),
      repositoryId: "repo-1",
      repositoryFullName: "acme/api",
      pullRequestNumber: 42,
      triageStatus: "RESOLVED",
      resolvedCommitSha: "abc1234567890",
    };

    render(<FindingsClient {...defaultProps} findings={[resolvedFinding]} total={1} />);
    expect(screen.getByText("resolved by commit abc1234")).toBeInTheDocument();
  });

  it("renders expiry date badge on finding with triageExpiresAt (#1890)", () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const expiringFinding: any = {
      id: "f-expiring",
      type: "SECRET",
      severity: "MEDIUM",
      fileLocation: "src/auth/key.ts",
      codeSnippet: "KEY = 'test'",
      explanation: "Test secret.",
      remediation: "Remove.",
      promptInjectionSuspected: false,
      fingerprint: "fp-exp-1",
      createdAt: new Date(),
      repositoryId: "repo-1",
      repositoryFullName: "acme/api",
      pullRequestNumber: 1,
      triageStatus: "DISMISSED",
      triageExpiresAt: futureDate,
    };

    render(<FindingsClient {...defaultProps} findings={[expiringFinding]} total={1} />);
    expect(screen.getByText(new RegExp(`expires on ${futureDate.toLocaleDateString()}`))).toBeInTheDocument();
  });

  it("renders note badge when finding was auto-reopened from expired dismissal (#1890)", () => {
    const reopenedFinding: any = {
      id: "f-reopened",
      type: "VULNERABILITY",
      severity: "HIGH",
      fileLocation: "src/api/handler.ts",
      codeSnippet: "vuln()",
      explanation: "SQL injection.",
      remediation: "Use params.",
      promptInjectionSuspected: false,
      fingerprint: "fp-reopened-1",
      createdAt: new Date(),
      repositoryId: "repo-1",
      repositoryFullName: "acme/api",
      pullRequestNumber: 1,
      triageStatus: "OPEN",
      triageNote: "previous dismissal expired on 2026-11-20",
    };

    render(<FindingsClient {...defaultProps} findings={[reopenedFinding]} total={1} />);
    expect(screen.getByText(/previous dismissal expired on 2026-11-20/)).toBeInTheDocument();
  });
});
