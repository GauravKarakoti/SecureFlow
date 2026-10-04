import { describe, it, expect, vi, beforeEach } from "vitest";

const readFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({ readFile }));

import { GET } from "./route";

const SPEC = 'openapi: 3.1.0\ninfo:\n  title: SecureFlow API\n  version: "1.0.0"\n';

/** A path fragment that must never reach a caller. */
const SPEC_PATH_HINT = "/srv/secureflow/openapi.yaml";

describe("GET /api/openapi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves a 3.1 spec relabelled as 3.0.3", async () => {
    readFile.mockResolvedValue(SPEC);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      'openapi: 3.0.3\ninfo:\n  title: SecureFlow API\n  version: "1.0.0"\n',
    );
  });

  it("changes nothing but the version line", async () => {
    // Anything else this route rewrote would be a difference between the
    // playground and the real spec.
    const body = "info:\n  title: SecureFlow API\npaths: {}\n";
    readFile.mockResolvedValue(`openapi: 3.1.2\n${body}`);

    const response = await GET();

    await expect(response.text()).resolves.toBe(`openapi: 3.0.3\n${body}`);
  });

  it("leaves a spec that already declares 3.0 alone", async () => {
    const spec = "openapi: 3.0.1\ninfo:\n  title: SecureFlow API\n";
    readFile.mockResolvedValue(spec);

    const response = await GET();

    await expect(response.text()).resolves.toBe(spec);
  });

  it("rewrites only the top-level version key, not an indented mention of it", async () => {
    // `^` with the `m` flag anchors to the start of a line, and a nested key is
    // indented, so prose or examples that quote the version are untouched.
    const spec = "openapi: 3.1.0\ninfo:\n  description: |\n    openapi: 3.1.0 is quoted here\n";
    readFile.mockResolvedValue(spec);

    const response = await GET();

    await expect(response.text()).resolves.toBe(
      "openapi: 3.0.3\ninfo:\n  description: |\n    openapi: 3.1.0 is quoted here\n",
    );
  });

  it("reads openapi.yaml from the project root", async () => {
    readFile.mockResolvedValue(SPEC);

    await GET();

    const [specPath, encoding] = readFile.mock.calls[0];
    expect(String(specPath).replace(/\\/g, "/")).toBe(
      `${process.cwd().replace(/\\/g, "/")}/openapi.yaml`,
    );
    expect(encoding).toBe("utf8");
  });

  it("labels the response as YAML so the browser does not guess", async () => {
    readFile.mockResolvedValue(SPEC);

    const response = await GET();

    expect(response.headers.get("Content-Type")).toBe("application/yaml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("answers 500 when the spec is missing from the deployment", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "The OpenAPI specification is unavailable.",
    });
  });

  it("does not leak the filesystem path when reading fails", async () => {
    readFile.mockRejectedValue(new Error(`EACCES: permission denied, open '${SPEC_PATH_HINT}'`));

    const response = await GET();
    const body = await response.text();

    expect(body).not.toContain(SPEC_PATH_HINT);
  });
});
