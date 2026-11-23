/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CreateIssueDialog from "./create-issue-dialog";

const mockGetFindingIssuePrefill = vi.fn();
const mockCreateIssueForFinding = vi.fn();

vi.mock("@/lib/actions/finding-issues", () => ({
  getFindingIssuePrefill: (...args: unknown[]) => mockGetFindingIssuePrefill(...args),
  createIssueForFinding: (...args: unknown[]) => mockCreateIssueForFinding(...args),
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

describe("CreateIssueDialog Component (#1987)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a link to the issue directly when existingIssueUrl is provided", () => {
    render(
      <CreateIssueDialog
        findingId="f-1"
        existingIssueUrl="https://github.com/acme/repo/issues/77"
      />,
    );

    const link = screen.getByTestId("finding-issue-link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://github.com/acme/repo/issues/77");
    expect(link).toHaveTextContent("Issue #77");
    expect(screen.queryByTestId("create-issue-button")).not.toBeInTheDocument();
  });

  it("renders Create Issue button when no issue exists", () => {
    render(<CreateIssueDialog findingId="f-1" />);

    expect(screen.getByTestId("create-issue-button")).toBeInTheDocument();
    expect(screen.queryByTestId("finding-issue-link")).not.toBeInTheDocument();
  });

  it("opens dialog, loads prefill, and creates issue on confirm", async () => {
    mockGetFindingIssuePrefill.mockResolvedValue({
      ok: true,
      alreadyCreated: false,
      prefill: {
        title: "[Security] CRITICAL: SECRET in test.ts",
        body: "Pre-filled description without secrets",
        repositoryFullName: "acme/repo",
      },
    });

    mockCreateIssueForFinding.mockResolvedValue({
      ok: true,
      issueUrl: "https://github.com/acme/repo/issues/101",
      issueNumber: 101,
    });

    const onCreated = vi.fn();
    render(<CreateIssueDialog findingId="f-1" onIssueCreated={onCreated} />);

    // Click to open dialog
    fireEvent.click(screen.getByTestId("create-issue-button"));

    // Wait for prefill to populate inputs
    await waitFor(() => {
      expect(screen.getByTestId("issue-title-input")).toHaveValue(
        "[Security] CRITICAL: SECRET in test.ts",
      );
      expect(screen.getByTestId("issue-body-textarea")).toHaveValue(
        "Pre-filled description without secrets",
      );
    });

    // Click confirm create button
    fireEvent.click(screen.getByTestId("confirm-create-issue-button"));

    await waitFor(() => {
      expect(mockCreateIssueForFinding).toHaveBeenCalledWith("f-1", {
        title: "[Security] CRITICAL: SECRET in test.ts",
        body: "Pre-filled description without secrets",
      });
      expect(onCreated).toHaveBeenCalledWith("https://github.com/acme/repo/issues/101");
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Issue Created",
        }),
      );
    });
  });

  it("displays clear error message when GitHub App permission is missing", async () => {
    mockGetFindingIssuePrefill.mockResolvedValue({
      ok: true,
      alreadyCreated: false,
      prefill: {
        title: "[Security] HIGH: VULNERABILITY in api.ts",
        body: "Sanitized body",
        repositoryFullName: "acme/repo",
      },
    });

    const permissionError =
      "The SecureFlow GitHub App lacks 'issues: write' permission on acme/repo. Please grant 'Issues: Read and write' in the GitHub App settings.";

    mockCreateIssueForFinding.mockResolvedValue({
      ok: false,
      error: permissionError,
    });

    render(<CreateIssueDialog findingId="f-1" />);

    // Open dialog
    fireEvent.click(screen.getByTestId("create-issue-button"));

    await waitFor(() => {
      expect(screen.getByTestId("issue-title-input")).toBeInTheDocument();
    });

    // Click create
    fireEvent.click(screen.getByTestId("confirm-create-issue-button"));

    await waitFor(() => {
      const errorBanner = screen.getByTestId("create-issue-error");
      expect(errorBanner).toBeInTheDocument();
      expect(errorBanner).toHaveTextContent(permissionError);
    });
  });
});
