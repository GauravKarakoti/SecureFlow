import { describe, it, expect, vi, afterEach } from "vitest";
import { NetworkUnavailableError, requestAiFileScan } from "./api-client.js";
import { MAX_SCANNED_BYTES } from "../scanner.js";

const ELIGIBLE = [{ path: "src/app.ts", content: "console.log('hello');\n" }];

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

  it("throws NetworkUnavailableError on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    await expect(requestAiFileScan(ELIGIBLE, "https://secureflow.test")).rejects.toBeInstanceOf(
      NetworkUnavailableError,
    );
  });

  it("throws NetworkUnavailableError (with cause) when fetch rejects", async () => {
    const cause = new Error("socket hangup");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw cause;
      }),
    );

    const promise = requestAiFileScan(ELIGIBLE, "https://secureflow.test");
    await expect(promise).rejects.toBeInstanceOf(NetworkUnavailableError);
    await expect(promise).rejects.toMatchObject({ cause });
  });

  it("throws NetworkUnavailableError when the response is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    await expect(requestAiFileScan(ELIGIBLE, "https://secureflow.test")).rejects.toBeInstanceOf(
      NetworkUnavailableError,
    );
  });

  it("returns an empty array when findings is missing or not an array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ findings: "error" }), { status: 200 })),
    );
    await expect(requestAiFileScan(ELIGIBLE, "https://secureflow.test")).resolves.toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    await expect(requestAiFileScan(ELIGIBLE, "https://secureflow.test")).resolves.toEqual([]);
  });
});

describe("submitSbomScan & pollSbomScanStatus (#1589)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits SBOM file and receives job handle", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jobId: "sbom-job-123",
            status: "QUEUED",
            message: "Scan enqueued",
          }),
          { status: 202 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { submitSbomScan } = await import("./api-client.js");
    const res = await submitSbomScan(
      "package.json",
      JSON.stringify({ dependencies: { lodash: "4.17.20" } }),
      "https://secureflow.test",
      "test-token",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://secureflow.test/api/sbom/scan");
    expect((init.headers as any)["Authorization"]).toBe("Bearer test-token");
    expect(res.jobId).toBe("sbom-job-123");
    expect(res.status).toBe("QUEUED");
  });

  it("polls SBOM job status", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jobId: "sbom-job-123",
            status: "COMPLETED",
            result: {
              summary: {
                totalDependencies: 5,
                vulnerableDependencies: 1,
                criticalCount: 0,
                highCount: 1,
                mediumCount: 0,
                lowCount: 0,
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { pollSbomScanStatus } = await import("./api-client.js");
    const res = await pollSbomScanStatus("sbom-job-123", "https://secureflow.test", "test-token");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://secureflow.test/api/sbom/scan/status/sbom-job-123");
    expect(res.status).toBe("COMPLETED");
    expect(res.result?.summary?.vulnerableDependencies).toBe(1);
  });
});

describe("requestWeb3Explanation (#1589)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns Web3 explanation from remote API when available", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ecosystem: "solidity",
            explanation: "State changed after external call.",
            remediationSuggestions: ["Use ReentrancyGuard"],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { requestWeb3Explanation } = await import("./api-client.js");
    const res = await requestWeb3Explanation(
      {
        findingType: "Reentrancy",
        severity: "HIGH",
        description: "Reentrancy flaw detected",
        fileLocation: "Vault.sol",
        codeSnippet: "msg.sender.call{value: bal}(''); bal = 0;",
      },
      "https://secureflow.test",
    );

    expect(res.ecosystem).toBe("solidity");
    expect(res.explanation).toContain("State changed");
  });

  it("gracefully falls back to local Web3 explanation if API is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { requestWeb3Explanation } = await import("./api-client.js");
    const res = await requestWeb3Explanation(
      {
        findingType: "Reentrancy",
        severity: "HIGH",
        description: "Reentrancy flaw detected",
        fileLocation: "contracts/Staking.sol",
        codeSnippet: "msg.sender.call{value: bal}('');",
      },
      "https://secureflow.test",
    );

    expect(res.ecosystem).toBe("solidity");
    expect(res.explanation).toContain("[SecureFlow Web3]");
    expect(res.remediationSuggestions.length).toBeGreaterThan(0);
  });
});

describe("requestAudioDebriefWithFallback & requestExplainStreamWithFallback (#1701)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("requestAudioDebriefWithFallback", () => {
    it("returns network audio buffer when remote audio-debrief succeeds", async () => {
      const mockAudio = Buffer.from("remote-audio-binary-data");
      const fetchMock = vi.fn(
        async () =>
          new Response(mockAudio, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { requestAudioDebriefWithFallback } = await import("./api-client.js");
      const res = await requestAudioDebriefWithFallback({
        findingId: "f-123",
        baseUrl: "https://secureflow.test",
      });

      expect(res.source).toBe("network");
      expect(res.contentType).toBe("audio/mpeg");
      expect(res.audioBuffer.toString()).toBe("remote-audio-binary-data");
    });

    it("parses base64 audio when returned in JSON from scan endpoint", async () => {
      const mockBase64 = Buffer.from("base64-audio").toString("base64");
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ audioBase64: mockBase64 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { requestAudioDebriefWithFallback } = await import("./api-client.js");
      const res = await requestAudioDebriefWithFallback({
        summaryText: "Critical secrets detected",
        baseUrl: "https://secureflow.test",
      });

      expect(res.source).toBe("network");
      expect(res.audioBuffer.toString()).toBe("base64-audio");
    });

    it("falls back to local offline audio buffer when endpoint fails or circuit trips (503/500)", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Service Unavailable" }), {
            status: 503,
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { requestAudioDebriefWithFallback } = await import("./api-client.js");
      const res = await requestAudioDebriefWithFallback({
        findingId: "f-tripped",
        baseUrl: "https://secureflow.test",
      });

      expect(res.source).toBe("local_fallback");
      expect(res.audioBuffer).toBeDefined();
      expect(res.audioBuffer.length).toBeGreaterThan(0);
    });

    it("falls back to local offline audio buffer on network timeout or connection drop", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      });
      vi.stubGlobal("fetch", fetchMock);

      const { requestAudioDebriefWithFallback } = await import("./api-client.js");
      const res = await requestAudioDebriefWithFallback({
        findingId: "f-timeout",
        baseUrl: "https://secureflow.test",
        timeoutMs: 100,
      });

      expect(res.source).toBe("local_fallback");
      expect(res.audioBuffer).toBeDefined();
    });
  });

  describe("requestExplainStreamWithFallback", () => {
    it("streams chunks from remote SSE explain-stream when healthy", async () => {
      const sseBody = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"chunk","text":"Step 1"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"chunk","text":"Step 2"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"done","content":"Done"}\n\n'));
          controller.close();
        },
      });

      const fetchMock = vi.fn(
        async () =>
          new Response(sseBody, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { requestExplainStreamWithFallback } = await import("./api-client.js");
      const chunks = [];
      for await (const chunk of requestExplainStreamWithFallback({
        findingId: "finding-42",
        findingType: "SQL Injection",
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: "chunk", text: "Step 1" });
      expect(chunks[1]).toEqual({ type: "chunk", text: "Step 2" });
      expect(chunks[2]).toEqual({ type: "done", content: "Done" });
    });

    it("seamlessly degrades to local-model offline explanation when remote endpoint returns 503 or circuit breaker trips", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Circuit Breaker OPEN" }), {
            status: 503,
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { requestExplainStreamWithFallback } = await import("./api-client.js");
      const chunks = [];
      for await (const chunk of requestExplainStreamWithFallback({
        findingId: "f-sqli",
        findingType: "SQL Injection",
        severity: "CRITICAL",
        fileLocation: "src/auth.ts",
        description: "Raw SQL query concatenation",
        codeSnippet: "db.query('SELECT * FROM users WHERE id = ' + id)",
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].type).toBe("chunk");
      expect(chunks[0].text).toContain("[SecureFlow Offline Local Mode]");
      expect(chunks[0].text).toContain("SQL Injection (CRITICAL)");
      expect(chunks[0].text).toContain("src/auth.ts");
      expect(chunks[1].type).toBe("done");
      expect(chunks[1].content).toContain("Local Remediation Recommendations");
    });

    it("seamlessly degrades to local-model offline explanation when network connection drops", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("Network offline: ECONNREFUSED");
      });
      vi.stubGlobal("fetch", fetchMock);

      const { requestExplainStreamWithFallback } = await import("./api-client.js");
      const chunks = [];
      for await (const chunk of requestExplainStreamWithFallback({
        findingId: "f-offline",
        findingType: "Hardcoded Credential",
        severity: "HIGH",
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toContain("[SecureFlow Offline Local Mode]");
      expect(chunks[1].type).toBe("done");
    });
  });
});
