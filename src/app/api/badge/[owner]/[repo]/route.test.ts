import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  default: {
    repository: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
  },
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  TIERS: {
    STANDARD: {
      limit: 120,
      windowSeconds: 60,
      fallbackStrategy: "fail-open",
    },
  },
  withRateLimit: (handler: Function) => handler,
}));

vi.mock("@/lib/middleware/error-handler", () => ({
  withErrorHandler: (handler: Function) => handler,
}));

// ---------------------------------------------------------------------------
// Import the handler after mocks are wired.
// ---------------------------------------------------------------------------
import { GET } from "./route";

function makeRequest(owner: string, repo: string): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/badge/${owner}/${repo}`), { method: "GET" });
}

function makeParams(owner: string, repo: string) {
  return { params: Promise.resolve({ owner, repo }) };
}

describe("GET /api/badge/[owner]/[repo]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a green 'passing' badge when the latest PR is PASS", async () => {
    mockFindFirst.mockResolvedValue({
      publicBadgeEnabled: true,
      pullRequests: [{ status: "PASS" }],
    });

    const res = (await GET(makeRequest("acme", "app"), makeParams("acme", "app"))) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=300");

    const svg = await res.text();
    expect(svg).toContain("passing");
    expect(svg).toContain("#4c1"); // green
  });

  it("returns a yellow 'review required' badge for REVIEW_REQUIRED", async () => {
    mockFindFirst.mockResolvedValue({
      publicBadgeEnabled: true,
      pullRequests: [{ status: "REVIEW_REQUIRED" }],
    });

    const res = (await GET(makeRequest("acme", "app"), makeParams("acme", "app"))) as Response;

    const svg = await res.text();
    expect(svg).toContain("review required");
    expect(svg).toContain("#dfb317"); // yellow
  });

  it("returns a red 'blocked' badge for BLOCKED status", async () => {
    mockFindFirst.mockResolvedValue({
      publicBadgeEnabled: true,
      pullRequests: [{ status: "BLOCKED" }],
    });

    const res = (await GET(makeRequest("acme", "app"), makeParams("acme", "app"))) as Response;

    const svg = await res.text();
    expect(svg).toContain("blocked");
    expect(svg).toContain("#e05d44"); // red
  });

  it("returns 'unknown' when the repo has no pull requests", async () => {
    mockFindFirst.mockResolvedValue({
      publicBadgeEnabled: true,
      pullRequests: [],
    });

    const res = (await GET(makeRequest("acme", "app"), makeParams("acme", "app"))) as Response;

    const svg = await res.text();
    expect(svg).toContain("unknown");
    expect(svg).toContain("#9f9f9f"); // grey
  });

  it("never leaks status when publicBadgeEnabled is false", async () => {
    mockFindFirst.mockResolvedValue({
      publicBadgeEnabled: false,
      pullRequests: [{ status: "BLOCKED" }],
    });

    const res = (await GET(
      makeRequest("acme", "private"),
      makeParams("acme", "private"),
    )) as Response;

    const svg = await res.text();
    expect(svg).toContain("unknown");
    expect(svg).toContain("#9f9f9f");
    // Must NOT contain the real status
    expect(svg).not.toContain("blocked");
    expect(svg).not.toContain("#e05d44");
  });

  it("returns 'unknown' for a non-existent repository", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = (await GET(makeRequest("ghost", "nope"), makeParams("ghost", "nope"))) as Response;

    const svg = await res.text();
    expect(svg).toContain("unknown");
    expect(svg).toContain("#9f9f9f");
  });

  it("queries with the correct fullName and selects the right fields", async () => {
    mockFindFirst.mockResolvedValue(null);

    await GET(makeRequest("my-org", "my-repo"), makeParams("my-org", "my-repo"));

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { fullName: "my-org/my-repo", isActive: true },
      select: {
        publicBadgeEnabled: true,
        pullRequests: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
    });
  });

  it("returns valid SVG with proper XML structure", async () => {
    mockFindFirst.mockResolvedValue({
      publicBadgeEnabled: true,
      pullRequests: [{ status: "PASS" }],
    });

    const res = (await GET(makeRequest("acme", "app"), makeParams("acme", "app"))) as Response;

    const svg = await res.text();
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("SecureFlow");
    expect(svg).toContain("</svg>");
  });
});
