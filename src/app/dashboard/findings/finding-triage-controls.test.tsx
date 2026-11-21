/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FindingTriageControls from "./finding-triage-controls";
import { setFindingStatus, setFindingStatuses } from "@/lib/actions/triage";

const { mockToast } = vi.hoisted(() => ({
  mockToast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: mockToast,
    toasts: [],
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/lib/actions/triage", () => ({
  setFindingStatus: vi.fn().mockResolvedValue({ ok: true }),
  setFindingStatuses: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

const targets = [
  { repositoryId: "repo-1", fingerprint: "fp-1" },
  { repositoryId: "repo-1", fingerprint: "fp-2" },
];

describe("FindingTriageControls bulk actions (#677)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render bulk actions when there are no targets", () => {
    const { container } = render(<FindingTriageControls variant="bulk" targets={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders mark ignored and mark false positive buttons", () => {
    render(<FindingTriageControls variant="bulk" targets={targets} />);

    expect(screen.getByRole("button", { name: /mark resolved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark false positive/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark ignored/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.getByText("2 on this page")).toBeInTheDocument();
  });

  it("confirms mark ignored as IGNORED", async () => {
    render(<FindingTriageControls variant="bulk" targets={targets} />);

    fireEvent.click(screen.getByRole("button", { name: /mark ignored/i }));
    expect(screen.getByText(/Apply bulk triage to 2 findings\?/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply to all/i }));
    });

    expect(setFindingStatuses).toHaveBeenCalledWith({
      items: targets,
      status: "IGNORED",
      note: "",
      expiresAt: null,
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
      }),
    );
  });

  it("confirms mark false positive", async () => {
    render(<FindingTriageControls variant="bulk" targets={targets} />);

    fireEvent.change(screen.getByPlaceholderText(/optional note for this bulk action/i), {
      target: { value: "Known test keys" },
    });
    fireEvent.click(screen.getByRole("button", { name: /mark false positive/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply to all/i }));
    });

    expect(setFindingStatuses).toHaveBeenCalledWith({
      items: targets,
      status: "FALSE_POSITIVE",
      note: "Known test keys",
      expiresAt: null,
    });
  });

  it("confirms bulk dismiss with reason and note", async () => {
    render(<FindingTriageControls variant="bulk" targets={targets} />);

    expect(screen.getByRole("button", { name: /dismiss selected/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/optional note for this bulk action/i), {
      target: { value: "Test file mock credentials" },
    });
    fireEvent.click(screen.getByRole("button", { name: /dismiss selected/i }));

    expect(screen.getByText(/Apply bulk triage to 2 findings\?/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply to all/i }));
    });

    expect(setFindingStatuses).toHaveBeenCalledWith({
      items: targets,
      status: "DISMISSED",
      reason: "FALSE_POSITIVE",
      note: "Test file mock credentials",
      expiresAt: null,
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "success",
        title: "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
      }),
    );
  });

  it("displays warning toast when items are skipped due to access restrictions", async () => {
    vi.mocked(setFindingStatuses).mockResolvedValueOnce({
      ok: true,
      updatedCount: 1,
      skippedCount: 1,
      warning: "Updated 1 finding(s). Skipped 1 finding(s) in repositories you cannot access.",
    });

    render(<FindingTriageControls variant="bulk" targets={targets} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss selected/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply to all/i }));
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "default",
        title: "Bulk triage completed with warnings",
        description: "Updated 1 finding(s). Skipped 1 finding(s) in repositories you cannot access.",
      }),
    );
  });
});

describe("Single finding triage controls with dismissal expiry (#1890)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders triage expiry select for dismissal statuses", () => {
    render(
      <FindingTriageControls
        repositoryId="repo-1"
        fingerprint="fp-1"
        currentStatus="DISMISSED"
        currentNote="Accepted risk for release"
        currentReason="ACCEPTED_RISK"
      />,
    );

    expect(screen.getByTestId("triage-expiry-select")).toBeInTheDocument();
  });

  it("shows expired badge when currentExpiresAt is in the past", () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    render(
      <FindingTriageControls
        repositoryId="repo-1"
        fingerprint="fp-1"
        currentStatus="DISMISSED"
        currentNote="Accepted risk for release"
        currentReason="ACCEPTED_RISK"
        currentExpiresAt={pastDate}
      />,
    );

    expect(screen.getByText("expired")).toBeInTheDocument();
  });

  it("shows active expiry badge when currentExpiresAt is in the future", () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    render(
      <FindingTriageControls
        repositoryId="repo-1"
        fingerprint="fp-1"
        currentStatus="DISMISSED"
        currentNote="Accepted risk for release"
        currentReason="ACCEPTED_RISK"
        currentExpiresAt={futureDate}
      />,
    );

    expect(screen.getByText(new RegExp(`expires on ${futureDate.toLocaleDateString()}`))).toBeInTheDocument();
  });
});
