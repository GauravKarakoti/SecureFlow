/**
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  ConnectRepositoryWizard,
  WIZARD_STORAGE_KEY,
  DEFAULT_WIZARD_STATE,
} from "./connect-repository-wizard";
import * as connectRepoActions from "@/lib/actions/connect-repo";

vi.mock("@/lib/actions/connect-repo", () => ({
  checkRepositoryScanStatus: vi.fn(),
  recordSimulatedScan: vi.fn(),
  getConnectableRepositories: vi.fn(),
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: writeTextMock,
  },
  writable: true,
  configurable: true,
});

describe("ConnectRepositoryWizard Component (#2230)", () => {
  const mockInitialRepos = [
    {
      id: "repo-1",
      fullName: "acme/auth-api",
      owner: "acme",
      hasScans: true,
      lastScanAt: "2026-11-20T10:00:00Z",
    },
    {
      id: "repo-2",
      fullName: "acme/frontend-app",
      owner: "acme",
      hasScans: false,
      lastScanAt: null,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    writeTextMock.mockClear();
    window.localStorage.clear();
  });

  it("renders when open is true and presents Step 1", () => {
    render(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={vi.fn()}
        initialRepositories={mockInitialRepos}
      />,
    );

    expect(screen.getByTestId("connect-repo-wizard")).toBeInTheDocument();
    expect(screen.getByText("Step 1: Choose Repository")).toBeInTheDocument();
    expect(screen.getByTestId("repo-select")).toBeInTheDocument();
    expect(screen.getByTestId("repo-input")).toBeInTheDocument();
  });

  it("disables Next button on Step 1 if repository is empty", () => {
    render(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={vi.fn()}
        initialRepositories={[]}
      />,
    );

    const nextBtn = screen.getByTestId("wizard-next-btn");
    expect(nextBtn).toBeDisabled();

    // Type a repo name
    const repoInput = screen.getByTestId("repo-input");
    fireEvent.change(repoInput, { target: { value: "my-org/my-service" } });

    expect(nextBtn).toBeEnabled();
  });

  it("progresses through all 5 steps and matches choices", async () => {
    render(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={vi.fn()}
        initialRepositories={mockInitialRepos}
      />,
    );

    // Step 1: Select repo
    const repoSelect = screen.getByTestId("repo-select");
    fireEvent.change(repoSelect, { target: { value: "acme/frontend-app" } });

    // Click Next
    fireEvent.click(screen.getByTestId("wizard-next-btn"));

    // Step 2: Scan Options
    expect(screen.getByText("Step 2: Scan & Policy Options")).toBeInTheDocument();
    const severitySelect = screen.getByTestId("severity-select");
    fireEvent.change(severitySelect, { target: { value: "medium" } });

    const failSelect = screen.getByTestId("fail-threshold-select");
    fireEvent.change(failSelect, { target: { value: "critical" } });

    // Toggle AI remediation
    const aiToggle = screen.getByTestId("ai-remediation-toggle");
    fireEvent.click(aiToggle);

    // Click Next
    fireEvent.click(screen.getByTestId("wizard-next-btn"));

    // Step 3: Workflow File
    expect(screen.getByText("Step 3: Workflow File Generation")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-file-path")).toHaveTextContent(".github/workflows/secureflow.yml");
    const preview = screen.getByTestId("workflow-yaml-preview");
    expect(preview).toHaveTextContent("acme/frontend-app");
    expect(preview).toHaveTextContent('severity: "medium"');
    expect(preview).toHaveTextContent('fail-threshold: "critical"');
    expect(preview).toHaveTextContent('ai-remediation: "true"');
    expect(preview).toHaveTextContent("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");

    // Copy buttons
    const copyYamlBtn = screen.getByTestId("copy-yaml-btn");
    fireEvent.click(copyYamlBtn);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining("SecureFlow Security Scan"));

    const copyPathBtn = screen.getByTestId("copy-path-btn");
    fireEvent.click(copyPathBtn);
    expect(writeTextMock).toHaveBeenCalledWith(".github/workflows/secureflow.yml");

    // Click Next
    fireEvent.click(screen.getByTestId("wizard-next-btn"));

    // Step 4: Secrets Guide
    expect(screen.getByText("Step 4: Configure GitHub Secrets")).toBeInTheDocument();
    expect(screen.getByText("GITHUB_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("SECUREFLOW_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("OPENAI_API_KEY")).toBeInTheDocument();

    const copySecretBtn = screen.getByTestId("copy-secret-openai");
    fireEvent.click(copySecretBtn);
    expect(writeTextMock).toHaveBeenCalledWith("OPENAI_API_KEY");

    // Click Next
    fireEvent.click(screen.getByTestId("wizard-next-btn"));

    // Step 5: Confirm Scan
    expect(screen.getByText("Step 5: Confirm First Scan Arrival")).toBeInTheDocument();
    expect(screen.getByTestId("waiting-scan-card")).toBeInTheDocument();

    // Check Scan action
    vi.mocked(connectRepoActions.checkRepositoryScanStatus).mockResolvedValueOnce({
      hasScan: true,
      scan: {
        id: "scan-123",
        createdAt: "2026-11-28T12:00:00Z",
        riskScore: 95,
        policyDecision: "PASSED",
        findingsCount: 0,
      },
    });

    const checkScanBtn = screen.getByTestId("check-scan-btn");
    fireEvent.click(checkScanBtn);

    await waitFor(() => {
      expect(screen.getByTestId("scan-confirmed-card")).toBeInTheDocument();
    });
    expect(screen.getByText("First Scan Received!")).toBeInTheDocument();
    expect(screen.getByText("PASSED")).toBeInTheDocument();
  });

  it("can be navigated and completed entirely using the keyboard", () => {
    const handleClose = vi.fn();

    render(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={handleClose}
        initialRepositories={mockInitialRepos}
      />,
    );

    // Initial focus on step 1 Next button
    const nextBtn = screen.getByTestId("wizard-next-btn");
    nextBtn.focus();
    expect(nextBtn).toHaveFocus();

    // Advance to Step 2
    fireEvent.click(nextBtn);
    expect(screen.getByText("Step 2: Scan & Policy Options")).toBeInTheDocument();

    // Advance to Step 3
    const nextBtn2 = screen.getByTestId("wizard-next-btn");
    nextBtn2.focus();
    fireEvent.click(nextBtn2);
    expect(screen.getByText("Step 3: Workflow File Generation")).toBeInTheDocument();

    // Focus copy YAML button and click
    const copyYamlBtn = screen.getByTestId("copy-yaml-btn");
    copyYamlBtn.focus();
    fireEvent.click(copyYamlBtn);
    expect(writeTextMock).toHaveBeenCalled();

    // Advance to Step 4
    const nextBtn3 = screen.getByTestId("wizard-next-btn");
    nextBtn3.focus();
    fireEvent.click(nextBtn3);
    expect(screen.getByText("Step 4: Configure GitHub Secrets")).toBeInTheDocument();

    // Advance to Step 5
    const nextBtn4 = screen.getByTestId("wizard-next-btn");
    nextBtn4.focus();
    fireEvent.click(nextBtn4);
    expect(screen.getByText("Step 5: Confirm First Scan Arrival")).toBeInTheDocument();

    // Finish button should be present and focusable
    const finishBtn = screen.getByTestId("wizard-finish-btn");
    finishBtn.focus();
    expect(finishBtn).toHaveFocus();
    fireEvent.click(finishBtn);
    expect(handleClose).toHaveBeenCalledWith(false);
  });

  it("preserves choices and step across closing and reopening the wizard", () => {
    const { rerender } = render(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={vi.fn()}
        initialRepositories={mockInitialRepos}
      />,
    );

    // Enter custom repo and advance to Step 2
    const repoInput = screen.getByTestId("repo-input");
    fireEvent.change(repoInput, { target: { value: "org/secret-repo" } });

    fireEvent.click(screen.getByTestId("wizard-next-btn"));
    expect(screen.getByText("Step 2: Scan & Policy Options")).toBeInTheDocument();

    // Select severity: critical
    const severitySelect = screen.getByTestId("severity-select");
    fireEvent.change(severitySelect, { target: { value: "critical" } });

    // Verify localStorage has the saved state
    const savedRaw = window.localStorage.getItem(WIZARD_STORAGE_KEY);
    expect(savedRaw).toBeTruthy();
    const saved = JSON.parse(savedRaw!);
    expect(saved.repository).toBe("org/secret-repo");
    expect(saved.severity).toBe("critical");
    expect(saved.step).toBe(2);

    // Simulate closing the wizard
    rerender(
      <ConnectRepositoryWizard
        open={false}
        onOpenChange={vi.fn()}
        initialRepositories={mockInitialRepos}
      />,
    );

    // Reopen the wizard
    rerender(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={vi.fn()}
        initialRepositories={mockInitialRepos}
      />,
    );

    // Choices and step are preserved!
    expect(screen.getByText("Step 2: Scan & Policy Options")).toBeInTheDocument();
    expect(screen.getByTestId("severity-select")).toHaveValue("critical");
  });

  it("resets state to defaults when Reset button is clicked", () => {
    window.localStorage.setItem(
      WIZARD_STORAGE_KEY,
      JSON.stringify({
        step: 3,
        repository: "custom/repo",
        severity: "critical",
      }),
    );

    render(
      <ConnectRepositoryWizard
        open={true}
        onOpenChange={vi.fn()}
        initialRepositories={mockInitialRepos}
      />,
    );

    // Should open on Step 3 from saved state
    expect(screen.getByText("Step 3: Workflow File Generation")).toBeInTheDocument();

    // Click Reset
    fireEvent.click(screen.getByTestId("reset-wizard-btn"));

    // Returns to Step 1 with default values
    expect(screen.getByText("Step 1: Choose Repository")).toBeInTheDocument();
    const savedAfter = JSON.parse(window.localStorage.getItem(WIZARD_STORAGE_KEY)!);
    expect(savedAfter.step).toBe(1);
    expect(savedAfter.repository).toBe("acme/auth-api");
    expect(savedAfter.severity).toBe("low");
  });
});
