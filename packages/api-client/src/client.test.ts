import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSecureFlowClient, ApiError } from "./client.js";

describe("@secureflow/api-client (#2105)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("configures baseUrl and includes Authorization bearer token header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          findings: [{ id: "find-1", type: "SECRET", severity: "CRITICAL" }],
          total: 1,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const client = createSecureFlowClient({
      baseUrl: "https://api.secureflow.dev",
      token: "sft_abcdef0123456789",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const result = await client.get("/api/findings", {
      params: {
        query: { severity: "CRITICAL", limit: 10 },
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];

    expect(requestUrl).toBe("https://api.secureflow.dev/api/findings?severity=CRITICAL&limit=10");
    expect(requestInit.method).toBe("GET");
    expect((requestInit.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sft_abcdef0123456789"
    );
    expect((requestInit.headers as Record<string, string>)["Accept"]).toBe("application/json");

    expect(result.status).toBe(200);
    expect((result.data as any).findings[0].id).toBe("find-1");
  });

  it("resolves path parameters correctly in URL", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "finding-xyz-123",
          type: "INJECTION",
          severity: "HIGH",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const client = createSecureFlowClient({
      baseUrl: "http://localhost:9002",
      token: "sft_test_token",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const result = await client.get("/api/findings/{id}", {
      params: {
        path: { id: "finding-xyz-123" },
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9002/api/findings/finding-xyz-123",
      expect.objectContaining({
        method: "GET",
      })
    );
    expect((result.data as any).id).toBe("finding-xyz-123");
  });

  it("serializes JSON body and sets Content-Type header on POST requests", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jobId: "job-999",
          status: "PENDING",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const client = createSecureFlowClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    const result = await client.post("/api/findings", {
      body: {
        repositoryId: "repo-1",
        commitSha: "a1b2c3d4",
      },
    });

    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
    expect(requestInit.body).toBe(
      JSON.stringify({ repositoryId: "repo-1", commitSha: "a1b2c3d4" })
    );
    expect((result.data as any).jobId).toBe("job-999");
  });

  it("throws ApiError with error status and payload when response is not ok", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "UNAUTHORIZED",
          message: "Invalid or expired API token",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const client = createSecureFlowClient({
      token: "sft_invalid",
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(client.get("/api/findings")).rejects.toThrow(ApiError);

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "FORBIDDEN",
        }),
        {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    try {
      await client.get("/api/admin/export");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(403);
      expect(err.message).toBe("FORBIDDEN");
    }
  });
});
