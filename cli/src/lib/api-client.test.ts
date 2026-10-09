import { describe, it, expect, vi, afterEach } from "vitest";
import { requestAiFileScan } from "./api-client.js";
import { MAX_SCANNED_BYTES } from "../scanner.js";

function stubFetch() {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ findings: [] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function uploadedPaths(fetchMock: ReturnType<typeof stubFetch>): string[] {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as { files: Array<{ path: string }> };
  return body.files.map((file) => file.path);
}

describe("requestAiFileScan", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads only the staged files the local scan would read", async () => {
    const fetchMock = stubFetch();

    await requestAiFileScan(
      [
        { path: "src/app.ts", content: "console.log('hello');\n" },
        { path: "package-lock.json", content: '{"lockfileVersion":3}' },
        { path: "assets/logo.png", content: "PNG image data" },
        { path: "fixtures/data.txt", content: "a\u0000b" },
        { path: "dist/bundle.js", content: "x".repeat(MAX_SCANNED_BYTES + 1) },
      ],
      "https://secureflow.test",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(uploadedPaths(fetchMock)).toEqual(["src/app.ts"]);
  });

  it("makes no request when nothing staged is eligible", async () => {
    const fetchMock = stubFetch();

    const findings = await requestAiFileScan(
      [{ path: "yarn.lock", content: "# yarn lockfile v1\n" }],
      "https://secureflow.test",
    );

    expect(findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
