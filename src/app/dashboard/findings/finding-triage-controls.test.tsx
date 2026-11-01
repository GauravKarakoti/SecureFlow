/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FindingTriageControls from "./finding-triage-controls";
import { setFindingStatuses } from "@/lib/actions/triage";

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
});
