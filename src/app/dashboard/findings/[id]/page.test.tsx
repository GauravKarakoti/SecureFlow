/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { authMock, findFirstMock, findUniqueMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findFirstMock: vi.fn(),
  findUniqueMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  default: {
    finding: { findFirst: findFirstMock },
    findingTriage: { findUnique: findUniqueMock },
  },
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock, notFound: notFoundMock }));

vi.mock("@/components/findings/finding-audio-player", () => ({
  default: (props: {
    findingId: string;
    findingType: string;
    severity: string;
    autoFetch: boolean;
  }) => (
    <div
      data-testid="audio-player"
      data-finding-id={props.findingId}
      data-type={props.findingType}
      data-severity={props.severity}
      data-auto-fetch={String(props.autoFetch)}
    />
  ),
}));

vi.mock("@/components/streaming-explanation", () => ({
  default: (props: { findingId: string; storedExplanation: string }) => (
    <div data-testid="streaming-explanation" data-finding-id={props.findingId}>
      {props.storedExplanation}
    </div>
  ),
}));

vi.mock("./finding-actions", () => ({
  default: (props: {
    findingId: string;
    initialSeverity: string;
    initialTriageStatus?: string;
    initialNote?: string;
  }) => (
    <div
      data-testid="finding-actions"
      data-finding-id={props.findingId}
      data-severity={props.initialSeverity}
      data-triage-status={props.initialTriageStatus}
      data-note={props.initialNote}
    />
  ),
}));

import FindingDetailPage from "./page";

const baseFinding = {
  id: "finding-1",
  type: "SQL Injection",
  severity: "CRITICAL",
  fileLocation: "src/api/users.ts",
  fingerprint: "fp-123456",
  explanation: "User input is concatenated into a SQL string.",
  remediation: "Use parameterized queries.",
  codeSnippet: "db.query(sql + id)",
  promptInjectionSuspected: false,
  scanResult: {
    pullRequest: {
      prNumber: 42,
      repository: { id: "repo-1", fullName: "acme/widgets" },
    },
  },
};

async function renderPage(id = "finding-1") {
  render(await FindingDetailPage({ params: Promise.resolve({ id }) }));
}

describe("FindingDetailPage server component (#1372, #1465)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    findFirstMock.mockResolvedValue(baseFinding);
    findUniqueMock.mockResolvedValue({
      status: "OPEN",
      note: "Initial pending triage",
    });
  });

  it("redirects unauthenticated visitors to sign in without querying the database", async () => {
    authMock.mockResolvedValue(null);

    await expect(
      FindingDetailPage({ params: Promise.resolve({ id: "finding-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT: /api/auth/signin");
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("scopes the lookup to findings owned by the signed-in user", async () => {
    await renderPage("finding-9");

    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock.mock.calls[0][0].where).toEqual({
      id: "finding-9",
      scanResult: { pullRequest: { repository: { userId: "user-1" } } },
    });
  });

  it("queries FindingTriage for initial status using repository ID and fingerprint", async () => {
    await renderPage();

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: {
        repositoryId_fingerprint: {
          repositoryId: "repo-1",
          fingerprint: "fp-123456",
        },
      },
    });
  });

  it("renders FindingActions with initial finding and triage data", async () => {
    findUniqueMock.mockResolvedValue({
      status: "RESOLVED",
      note: "Patched via PR #43",
    });

    await renderPage();

    const actions = screen.getByTestId("finding-actions");
    expect(actions).toBeInTheDocument();
    expect(actions.dataset.findingId).toBe("finding-1");
    expect(actions.dataset.severity).toBe("CRITICAL");
    expect(actions.dataset.triageStatus).toBe("RESOLVED");
    expect(actions.dataset.note).toBe("Patched via PR #43");
  });

  it("returns a not-found response when the finding is missing or owned by someone else", async () => {
    findFirstMock.mockResolvedValue(null);

    await expect(FindingDetailPage({ params: Promise.resolve({ id: "nope" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it("renders the finding header with type, themed severity, repository, PR and file", async () => {
    await renderPage();

    expect(screen.getByText("SQL Injection Detected")).toBeInTheDocument();
    expect(screen.getByText("Interpol Breach")).toBeInTheDocument();
    expect(screen.getByText(/acme\/widgets/)).toBeInTheDocument();
    expect(screen.getByText(/PR #42/)).toBeInTheDocument();
    expect(screen.getByText(/src\/api\/users\.ts/)).toBeInTheDocument();
    expect(screen.queryByText(/Verify manually/)).not.toBeInTheDocument();
  });

  it("flags findings where prompt injection is suspected", async () => {
    findFirstMock.mockResolvedValue({ ...baseFinding, promptInjectionSuspected: true });

    await renderPage();

    expect(screen.getByText(/Verify manually/)).toBeInTheDocument();
  });

  it("wires the audio debrief player without auto-fetching audio", async () => {
    await renderPage();

    expect(screen.getByText("Audio Debrief")).toBeInTheDocument();
    const player = screen.getByTestId("audio-player");
    expect(player.dataset.findingId).toBe("finding-1");
    expect(player.dataset.type).toBe("SQL Injection");
    expect(player.dataset.severity).toBe("CRITICAL");
    expect(player.dataset.autoFetch).toBe("false");
  });

  it("passes the stored explanation to the streaming explanation panel", async () => {
    await renderPage();

    const explanation = screen.getByTestId("streaming-explanation");
    expect(explanation.dataset.findingId).toBe("finding-1");
    expect(explanation).toHaveTextContent("User input is concatenated into a SQL string.");
  });

  it("shows the stored remediation guidance and source snippet", async () => {
    await renderPage();

    expect(screen.getByText("Remediation Guidance")).toBeInTheDocument();
    expect(screen.getByText("Use parameterized queries.")).toBeInTheDocument();
    expect(screen.getByText("db.query(sql + id)")).toBeInTheDocument();
  });

  it("falls back to placeholder copy when explanation, remediation and snippet are empty", async () => {
    findFirstMock.mockResolvedValue({
      ...baseFinding,
      explanation: null,
      remediation: null,
      codeSnippet: null,
    });

    await renderPage();

    expect(screen.getByTestId("streaming-explanation")).toHaveTextContent(
      "No explanation provided.",
    );
    expect(
      screen.getByText(
        "Follow standard security practices to sanitize input and isolate privileges.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Code snippet unavailable.")).toBeInTheDocument();
  });

  it("links to the findings list and to the AI remediation page for this finding", async () => {
    await renderPage();

    expect(screen.getByRole("link", { name: /Back to Findings/ })).toHaveAttribute(
      "href",
      "/dashboard/findings",
    );
    expect(screen.getByRole("link", { name: /AI Remediation/ })).toHaveAttribute(
      "href",
      "/dashboard/findings/finding-1/remediation",
    );
  });
});
