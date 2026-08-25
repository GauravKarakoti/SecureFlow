/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import FindingsClient from "./findings-client";

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

  const mockFindings = [
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

  it("renders stat boxes with correct values", () => {
    render(<FindingsClient findings={mockFindings} stats={mockStats} />);

    expect(screen.getByText("Security Findings")).toBeInTheDocument();
    expect(screen.getByText("Critical Secrets")).toBeInTheDocument();
    expect(screen.getByText("Vulnerabilities")).toBeInTheDocument();
    expect(screen.getByText("Misconfigs")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("2 Findings")).toBeInTheDocument();
  });

  it("renders finding items and handles prompt injection and triage badges", () => {
    render(<FindingsClient findings={mockFindings} stats={mockStats} />);

    expect(screen.getByText("SECRET Detected")).toBeInTheDocument();
    expect(screen.getByText("VULNERABILITY Detected")).toBeInTheDocument();
    expect(screen.getByText("src/config/keys.ts")).toBeInTheDocument();
    expect(screen.getByText("src/auth/token.ts")).toBeInTheDocument();

    expect(screen.getByText("⚠️ Verify manually")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("renders empty state when findings array is empty", () => {
    render(<FindingsClient findings={[]} stats={{ ...mockStats, criticalSecrets: 0, vulnerabilities: 0, misconfigs: 0 }} />);

    expect(screen.getByText("No Security Findings")).toBeInTheDocument();
    expect(screen.getByText("Great news! Your repositories are currently secure.")).toBeInTheDocument();
  });
});
