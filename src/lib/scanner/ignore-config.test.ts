import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/armor/scanner", () => ({
  parseSecureFlowIgnore: (content: string) => {
    const ignoredPaths: string[] = [];
    const placeholders: string[] = [];
    let section: "paths" | "placeholders" = "paths";
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.toLowerCase() === "[placeholders]") {
        section = "placeholders";
        continue;
      }
      (section === "placeholders" ? placeholders : ignoredPaths).push(trimmed);
    }
    return { ignoredPaths, placeholders };
  },
}));

import {
  loadBaseIgnoreConfig,
  loadTrustedIgnoreConfig,
  resolveBaseRef,
  type IgnoreConfigClient,
} from "./ignore-config";

const getContent = vi.fn();
const pullsGet = vi.fn();
const client = {
  rest: { repos: { getContent }, pulls: { get: pullsGet } },
} as unknown as IgnoreConfigClient;

const repo = { owner: "acme", repo: "api" };
const file = (text: string) => ({ data: { content: Buffer.from(text).toString("base64") } });
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getContent.mockReset();
  pullsGet.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadBaseIgnoreConfig", () => {
  it("reads .secureflowignore at the base ref and parses both sections", async () => {
    getContent.mockResolvedValue(file("docs/**\n# note\ntests/**\n[placeholders]\nmy_fake_key"));

    const config = await loadBaseIgnoreConfig(client, { ...repo, baseRef: "main" });

    expect(getContent).toHaveBeenCalledWith({ ...repo, path: ".secureflowignore", ref: "main" });
    expect(config).toEqual({
      ignoredPaths: ["docs/**", "tests/**"],
      placeholders: ["my_fake_key"],
    });
  });

  it("treats a repository without the file as having no rules, without logging", async () => {
    getContent.mockRejectedValue(notFound());

    await expect(loadBaseIgnoreConfig(client, { ...repo, baseRef: "main" })).resolves.toEqual({
      ignoredPaths: [],
      placeholders: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to no rules, and says so, on any other failure", async () => {
    getContent.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 403 }));

    await expect(loadBaseIgnoreConfig(client, { ...repo, baseRef: "main" })).resolves.toEqual({
      ignoredPaths: [],
      placeholders: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ignores a directory of that name and a response without content", async () => {
    getContent.mockResolvedValueOnce({ data: [{ name: "x" }] });
    getContent.mockResolvedValueOnce({ data: { type: "submodule" } });
    getContent.mockResolvedValueOnce({ data: null });

    for (let i = 0; i < 3; i++) {
      await expect(loadBaseIgnoreConfig(client, { ...repo, baseRef: "main" })).resolves.toEqual({
        ignoredPaths: [],
        placeholders: [],
      });
    }
  });

  it("returns a fresh object each time", async () => {
    getContent.mockRejectedValue(notFound());

    const first = await loadBaseIgnoreConfig(client, { ...repo, baseRef: "main" });
    first.ignoredPaths.push("**");
    const second = await loadBaseIgnoreConfig(client, { ...repo, baseRef: "main" });

    expect(second.ignoredPaths).toEqual([]);
  });
});

describe("resolveBaseRef", () => {
  it("returns the branch the pull request merges into", async () => {
    pullsGet.mockResolvedValue({ data: { base: { ref: "develop" } } });

    await expect(resolveBaseRef(client, { ...repo, prNumber: 7 })).resolves.toBe("develop");
    expect(pullsGet).toHaveBeenCalledWith({ ...repo, pull_number: 7 });
  });

  it("returns null when the response has no usable base", async () => {
    pullsGet.mockResolvedValueOnce({ data: {} });
    pullsGet.mockResolvedValueOnce({ data: { base: { ref: "" } } });

    await expect(resolveBaseRef(client, { ...repo, prNumber: 7 })).resolves.toBeNull();
    await expect(resolveBaseRef(client, { ...repo, prNumber: 7 })).resolves.toBeNull();
  });

  it("returns null, and says so, when the lookup fails", async () => {
    pullsGet.mockRejectedValue(new Error("boom"));

    await expect(resolveBaseRef(client, { ...repo, prNumber: 7 })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("loadTrustedIgnoreConfig", () => {
  it("uses the base ref it is given without a lookup", async () => {
    getContent.mockResolvedValue(file("docs/**"));

    const config = await loadTrustedIgnoreConfig(client, { ...repo, prNumber: 7, baseRef: "main" });

    expect(pullsGet).not.toHaveBeenCalled();
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: "main" }));
    expect(config.ignoredPaths).toEqual(["docs/**"]);
  });

  it("looks the base ref up when the caller does not have one", async () => {
    pullsGet.mockResolvedValue({ data: { base: { ref: "release" } } });
    getContent.mockResolvedValue(file("docs/**"));

    await loadTrustedIgnoreConfig(client, { ...repo, prNumber: 7 });

    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: "release" }));
  });

  it("scans without ignore rules, and reads nothing, when no base can be determined", async () => {
    pullsGet.mockRejectedValue(new Error("boom"));

    await expect(loadTrustedIgnoreConfig(client, { ...repo, prNumber: 7 })).resolves.toEqual({
      ignoredPaths: [],
      placeholders: [],
    });
    expect(getContent).not.toHaveBeenCalled();
  });

  it("is not switched off by a .secureflowignore the pull request adds on its own branch", async () => {
    // The base has no ignore file; the pull request's head commit adds one that
    // ignores everything. Only the head would ever return it.
    getContent.mockImplementation(async ({ ref }: { ref: string }) => {
      if (ref === "main") throw notFound();
      return file("**\n[placeholders]\nAKIA");
    });

    const config = await loadTrustedIgnoreConfig(client, { ...repo, prNumber: 7, baseRef: "main" });

    expect(config).toEqual({ ignoredPaths: [], placeholders: [] });
    for (const [params] of getContent.mock.calls) {
      expect(params.ref).toBe("main");
    }
  });
});
