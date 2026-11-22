import { describe, expect, it, vi } from "vitest";
import {
  loadBaseCodeOwners,
  ownersForPath,
  parseCodeOwners,
  type CodeOwnersClient,
} from "./codeowners";

const base = { owner: "example", repo: "project", baseRef: "base-sha" };
const lookup = (implementation: CodeOwnersClient["rest"]["repos"]["getContent"]) => {
  const getContent = vi.fn(implementation);
  return { getContent, client: { rest: { repos: { getContent } } } };
};

describe("CODEOWNERS patterns", () => {
  const rules = parseCodeOwners(
    "# default\r\n* @everyone\r\n*.ts @platform @example/runtime admin@example.com # team\r\n" +
      "docs/ @guide\n/root.txt @root-only\n/docs/ @root-docs\n/docs/* @direct-docs\n" +
      "lib/**/fixtures/*.ts @fixtures\n/components/private\n**/logs @logger\n" +
      "!ignored @bad\n[a-z] @bad\ninvalid not-an-owner\n",
  );

  it.each([
    ["main.ts", ["@platform", "@example/runtime", "admin@example.com"]],
    ["deep/main.ts", ["@platform", "@example/runtime", "admin@example.com"]],
    ["deep/main.TS", ["@everyone"]],
    ["docs/nested/example.ts", ["@root-docs"]],
    ["docs/readme.txt", ["@direct-docs"]],
    ["examples/docs/nested/readme.txt", ["@guide"]],
    ["root.txt", ["@root-only"]],
    ["nested/root.txt", ["@everyone"]],
    ["lib/fixtures/mock.ts", ["@fixtures"]],
    ["lib/deep/fixtures/mock.ts", ["@fixtures"]],
    ["lib/deep/fixtures/sub/mock.ts", ["@platform", "@example/runtime", "admin@example.com"]],
    ["components/private/a.ts", []],
    ["nested/components/private/a.ts", ["@platform", "@example/runtime", "admin@example.com"]],
    ["build/runtime/logs/2026/main.log", ["@logger"]],
    ["invalid", ["@everyone"]],
    ["../outside", []],
  ])("matches %s and applies the last applicable rule", (file, owners) => {
    expect(ownersForPath(rules, file)).toEqual(owners);
  });

  it("treats a trailing globstar as a descendant match", () => {
    const descendants = parseCodeOwners("artifacts/** @build");
    expect(ownersForPath(descendants, "artifacts")).toEqual([]);
    expect(ownersForPath(descendants, "artifacts/debug/log")).toEqual(["@build"]);
  });

  it("returns a unique owner list and ignores binary, oversized and malformed files", () => {
    expect(ownersForPath(parseCodeOwners("* @same @same"), "src/file")).toEqual(["@same"]);
    expect(parseCodeOwners("x\0 @bad")).toEqual([]);
    expect(parseCodeOwners("x".repeat(3_000_000))).toEqual([]);
    expect(parseCodeOwners("!x @bad\n[abc] @bad\n* :unsupported")).toEqual([]);
  });
});

describe("base revision CODEOWNERS loader", () => {
  it("takes the .github file before the root file and uses only the base SHA", async () => {
    const { getContent, client } = lookup(async ({ ref, path }) => {
      if (ref === "head-sha" || path === "CODEOWNERS") return { data: "* @wrong" };
      return { data: "* @base-owner" };
    });
    const rules = await loadBaseCodeOwners(client, base);
    expect(ownersForPath(rules ?? [], "src/example.ts")).toEqual(["@base-owner"]);
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".github/CODEOWNERS",
        ref: "base-sha",
        owner: "example",
        repo: "project",
        headers: { accept: "application/vnd.github.raw+json" },
      }),
    );
  });

  it("falls through 404s in priority order and accepts an Octokit binary response", async () => {
    const { getContent, client } = lookup(async ({ path }) => {
      if (path !== "docs/CODEOWNERS") throw { status: 404 };
      return { data: new TextEncoder().encode("* @docs").buffer };
    });
    expect(ownersForPath((await loadBaseCodeOwners(client, base)) ?? [], "file")).toEqual([
      "@docs",
    ]);
    expect(getContent.mock.calls.map(([args]) => args.path)).toEqual([
      ".github/CODEOWNERS",
      "CODEOWNERS",
      "docs/CODEOWNERS",
    ]);
    expect(getContent.mock.calls.every(([args]) => args.ref === "base-sha")).toBe(true);
  });

  it("ignores head additions when the base revision has no file", async () => {
    const { getContent, client } = lookup(async ({ ref }) => {
      if (ref === "head-sha") return { data: "* @head-only" };
      throw { status: 404 };
    });
    expect(await loadBaseCodeOwners(client, base)).toBeNull();
    expect(getContent).toHaveBeenCalledTimes(3);
    expect(getContent.mock.calls.every(([args]) => args.ref === "base-sha")).toBe(true);
  });

  it.each([
    [
      "API denial",
      async () => {
        throw { status: 403 };
      },
    ],
    [
      "network failure",
      async () => {
        throw new Error("Connection lost");
      },
    ],
    ["directory", async () => ({ data: [] })],
    ["invalid encoding", async () => ({ data: Uint8Array.from([255]).buffer })],
    ["malformed file", async () => ({ data: "* not-an-owner" })],
  ] as const)("handles %s without trying lower-priority files", async (_name, getter) => {
    const { getContent, client } = lookup(getter);
    expect(await loadBaseCodeOwners(client, base)).toBeNull();
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("does not resolve a default revision when the PR base is missing", async () => {
    const { getContent, client } = lookup(async () => ({ data: "* @wrong" }));
    expect(await loadBaseCodeOwners(client, { ...base, baseRef: undefined })).toBeNull();
    expect(getContent).not.toHaveBeenCalled();
  });
});
