import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { scanPullRequestMock, rateLimitConfigs } = vi.hoisted(() => ({
  scanPullRequestMock: vi.fn(),
  rateLimitConfigs: [] as Array<{ keyPrefix: string; fallbackStrategy?: string }>,
}));

vi.mock("@/lib/armor/scanner", () => ({
  scanner: { scanPullRequest: scanPullRequestMock },
}));

vi.mock("@/lib/middleware/rate-limit", () => ({
  withRateLimit: <T>(handler: T, config: { keyPrefix: string; fallbackStrategy?: string }): T => {
    rateLimitConfigs.push(config);
    return handler;
  },
}));

vi.mock("@/lib/middleware/error-handler", () => {
  const AppError = class AppError extends Error {
    statusCode: number;
    constructor(msg: string, code = 400) {
      super(msg);
      this.statusCode = code;
    }
  };
  return {
    withErrorHandler:
      (fn: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message?: string };
          return {
            status: e.statusCode || 500,
            json: async () => ({ error: e.message }),
          };
        }
      },
    AppError,
  };
});

import { POST, MAX_FILES_PER_REQUEST, MAX_FILE_CONTENT_LENGTH, MAX_PATH_LENGTH } from "./route";

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/cli/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

describe("POST /api/cli/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scanPullRequestMock.mockResolvedValue([]);
  });

  it("is rate limited under its own fail-closed bucket", () => {
    const config = rateLimitConfigs.find((c) => c.keyPrefix === "cli:scan");
    expect(config).toBeDefined();
    expect(config?.fallbackStrategy).toBe("fail-closed");
  });

  it("scans each file as a fully added patch", async () => {
    const res = await post({ files: [{ path: "src/app.ts", content: "a\nb" }] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ findings: [] });
    expect(scanPullRequestMock).toHaveBeenCalledWith([
      { filename: "src/app.ts", patch: "@@ -0,0 +1,2 @@\n+a\n+b\n" },
    ]);
  });

  it("normalizes trailing newlines and handles empty content in synthetic patches", async () => {
    const res = await post({
      files: [
        { path: "src/with-newline.ts", content: "a\nb\n" },
        { path: "src/empty.ts", content: "" },
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ findings: [] });
    expect(scanPullRequestMock).toHaveBeenCalledWith([
      { filename: "src/with-newline.ts", patch: "@@ -0,0 +1,2 @@\n+a\n+b\n" },
      { filename: "src/empty.ts", patch: "" },
    ]);
  });

  it.each([
    ["a file without content", { files: [{ path: "src/app.ts" }] }],
    ["a null entry", { files: [null] }],
    ["a string entry", { files: ["src/app.ts"] }],
    ["a non-string path", { files: [{ path: 42, content: "x" }] }],
    ["a non-string content", { files: [{ path: "src/app.ts", content: { nested: true } }] }],
    ["an empty path", { files: [{ path: "", content: "x" }] }],
  ])("rejects %s with 400 before scanning", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });

  it("rejects when files array exceeds MAX_FILES_PER_REQUEST", async () => {
    const files = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => ({
      path: `file-${i}.ts`,
      content: "const a = 1;",
    }));

    const res = await post({ files });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `"files" array cannot contain more than ${MAX_FILES_PER_REQUEST} files per request`,
    });
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });

  it("rejects when file content exceeds MAX_FILE_CONTENT_LENGTH", async () => {
    const largeContent = "x".repeat(MAX_FILE_CONTENT_LENGTH + 1);
    const res = await post({
      files: [{ path: "huge.ts", content: largeContent }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `file content exceeds maximum size of ${MAX_FILE_CONTENT_LENGTH} characters`,
    });
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });

  it("rejects when file path exceeds MAX_PATH_LENGTH", async () => {
    const longPath = "a/".repeat(MAX_PATH_LENGTH) + "file.ts";
    const res = await post({
      files: [{ path: longPath, content: "ok" }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `each file path must not exceed ${MAX_PATH_LENGTH} characters`,
    });
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });

  it("still rejects a missing or empty files array", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ files: [] })).status).toBe(400);
    expect(scanPullRequestMock).not.toHaveBeenCalled();
  });
});
