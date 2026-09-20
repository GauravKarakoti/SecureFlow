import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockContributors = [
  {
    id: "alice",
    login: "alice",
    htmlUrl: "https://github.com/alice",
    avatarUrl: "https://github.com/alice.png",
    score: 10,
    rank: 1,
    prCount: 12,
    mergedCount: 10,
  },
  {
    id: "bob",
    login: "bob",
    htmlUrl: "https://github.com/bob",
    avatarUrl: "https://github.com/bob.png",
    score: 5,
    rank: 2,
    prCount: 6,
    mergedCount: 5,
  },
];

vi.mock("@/app/leaderboard/aggregate", () => ({
  loadLeaderboard: vi.fn(async () => mockContributors),
}));

import { GET } from "./route";
import { loadLeaderboard } from "@/app/leaderboard/aggregate";
import { resetLeaderboardBroadcaster } from "@/lib/leaderboard/broadcaster";

/** The shape of a Prisma connection failure: it names the database host. */
const DB_ERROR = "Can't reach database server at `db.internal-prod.example:5432`";

async function readSSE(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  // Read first chunk (initial state)
  const { value } = await reader.read();
  if (value) {
    buffer += decoder.decode(value);
  }

  for (const block of buffer.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (line) {
      events.push(JSON.parse(line.slice("data: ".length)));
    }
  }

  // Cancel reader to trigger abort/cleanup
  await reader.cancel();
  return events;
}

describe("GET /api/leaderboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns standard JSON data when stream query param is not set", async () => {
    const req = new NextRequest("http://localhost:9002/api/leaderboard");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.contributors).toEqual(mockContributors);
    expect(data.timestamp).toBeDefined();
  });

  it("returns SSE stream when stream=true is provided", async () => {
    const req = new NextRequest("http://localhost:9002/api/leaderboard?stream=true");
    const res = await GET(req);

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");

    const events = await readSSE(res);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].contributors).toEqual(mockContributors);
  });

  it("returns SSE stream when Accept header includes text/event-stream", async () => {
    const req = new NextRequest("http://localhost:9002/api/leaderboard", {
      headers: { accept: "text/event-stream" },
    });
    const res = await GET(req);

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  describe("when the leaderboard cannot be loaded", () => {
    beforeEach(() => {
      resetLeaderboardBroadcaster();
      vi.mocked(loadLeaderboard).mockRejectedValue(new Error(DB_ERROR));
    });

    it("does not return the database error to the caller as JSON", async () => {
      const res = await GET(new NextRequest("http://localhost:9002/api/leaderboard"));

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("db.internal-prod.example");
      expect(body.error).toBe("Failed to load leaderboard data");
    });

    it("does not stream the database error to SSE subscribers", async () => {
      const res = await GET(new NextRequest("http://localhost:9002/api/leaderboard?stream=true"));

      const events = await readSSE(res);

      expect(events).toEqual([{ error: "Failed to load leaderboard data" }]);
    });
  });
});
