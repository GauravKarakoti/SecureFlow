import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, DELETE } from "./route";
import { POST as batchReplayPost } from "./replay/route";
import { POST as singleReplayPost } from "./[id]/replay/route";
import { enqueueToDlq, clearDlqStore, getDlqEntry } from "@/lib/webhooks/dlq";

let mockSessionUser: { id: string; name?: string; roles?: string[] } | null = {
  id: "admin-1",
  name: "Admin User",
  roles: ["ADMIN"],
};

vi.mock("@/auth", () => ({
  auth: vi.fn(() => Promise.resolve(mockSessionUser ? { user: mockSessionUser } : null)),
}));

describe("DLQ API Routes (#2061)", () => {
  beforeEach(() => {
    clearDlqStore();
    mockSessionUser = {
      id: "admin-1",
      name: "Admin User",
      roles: ["ADMIN"],
    };
  });

  it("blocks non-admin users with 403 on GET /api/webhooks/dlq", async () => {
    mockSessionUser = { id: "user-1", roles: ["MEMBER"] };
    const req = new NextRequest("http://localhost/api/webhooks/dlq");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("returns quarantined DLQ entries on GET /api/webhooks/dlq", async () => {
    enqueueToDlq({
      webhookId: "wh_test",
      url: "https://example.com/webhook",
      secret: "sec",
      event: "scan.completed",
      envelope: {
        id: "evt_1",
        event: "scan.completed",
        timestamp: new Date().toISOString(),
        data: {},
      },
      failureReason: "HTTP 500",
      statusCode: 500,
    });

    const req = new NextRequest("http://localhost/api/webhooks/dlq");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.entries[0].webhookId).toBe("wh_test");
  });

  it("purges DLQ entries on DELETE /api/webhooks/dlq", async () => {
    const entry = enqueueToDlq({
      webhookId: "wh_test",
      url: "https://example.com/webhook",
      secret: "sec",
      event: "scan.completed",
      envelope: {
        id: "evt_1",
        event: "scan.completed",
        timestamp: new Date().toISOString(),
        data: {},
      },
      failureReason: "HTTP 500",
    });

    const req = new NextRequest(`http://localhost/api/webhooks/dlq?id=${entry.id}`, {
      method: "DELETE",
    });
    const res = await DELETE(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(getDlqEntry(entry.id)?.status).toBe("purged");
  });

  it("replays individual entry on POST /api/webhooks/dlq/[id]/replay", async () => {
    const entry = enqueueToDlq({
      webhookId: "wh_test",
      url: "https://example.com/webhook",
      secret: "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      event: "scan.completed",
      envelope: {
        id: "evt_1",
        event: "scan.completed",
        timestamp: new Date().toISOString(),
        data: {},
      },
      failureReason: "HTTP 500",
    });

    // Mock global fetch for replay
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    }) as any;

    try {
      const req = new NextRequest(`http://localhost/api/webhooks/dlq/${entry.id}/replay`, {
        method: "POST",
      });
      const res = await singleReplayPost(req, { params: Promise.resolve({ id: entry.id }) });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(getDlqEntry(entry.id)?.status).toBe("replayed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("batch replays quarantined entries on POST /api/webhooks/dlq/replay", async () => {
    const entry = enqueueToDlq({
      webhookId: "wh_batch",
      url: "https://example.com/webhook",
      secret: "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      event: "scan.completed",
      envelope: {
        id: "evt_batch_1",
        event: "scan.completed",
        timestamp: new Date().toISOString(),
        data: {},
      },
      failureReason: "HTTP 500",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    }) as any;

    try {
      const req = new NextRequest("http://localhost/api/webhooks/dlq/replay", {
        method: "POST",
        body: JSON.stringify({ ids: [entry.id] }),
      });
      const res = await batchReplayPost(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.succeeded).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
