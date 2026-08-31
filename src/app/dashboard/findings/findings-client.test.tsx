/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import FindingsClient from "./findings-client";

// Mock Next.js app router hooks
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/dashboard/findings",
  useSearchParams: () => new URLSearchParams(),
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

  it("renders empty state when findings array is empty", () => {
    render(
      <FindingsClient 
        {...defaultProps} 
        findings={[]} 
        total={0} 
        stats={{ ...mockStats, criticalSecrets: 0, vulnerabilities: 0, misconfigs: 0 }} 
      />
    );

    expect(screen.getByText("No Security Findings")).toBeInTheDocument();
    expect(screen.getByText("Great news! Your repositories are currently secure.")).toBeInTheDocument();
  });
});