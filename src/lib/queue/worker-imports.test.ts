import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

/**
 * Importing a module must not start a queue consumer.
 *
 * `worker.ts`, `outboundWorker.ts` and `sbomWorker.ts` construct their BullMQ
 * Worker at module scope, so whatever process imports them starts consuming
 * that queue. Only the worker entry point (`scripts/start-worker.ts`) should do
 * that. `scanEngine.ts` used to import `getGitHubAppCredentials` from
 * `@/lib/queue/worker`, so importing the scan engine for one helper also started
 * the `github-webhooks` consumer.
 */

const constructed = vi.hoisted(() => [] as string[]);

vi.mock("bullmq", () => {
  class Worker {
    constructor(name: string) {
      constructed.push(name);
    }
    on() {
      return this;
    }
    async close() {}
  }
  class Queue {
    constructor(public name: string) {}
    add = vi.fn();
    on() {
      return this;
    }
  }
  class UnrecoverableError extends Error {}
  class DelayedError extends Error {}
  return { Worker, Queue, UnrecoverableError, DelayedError, Job: class {} };
});
vi.mock("@/ai/flows/developer-receives-ai-security-explanations", () => ({
  developerReceivesAISecurityExplanations: vi.fn(),
}));

const root = path.resolve(import.meta.dirname, "../../..");

/** Modules that construct a BullMQ Worker as a side effect of being imported. */
const CONSUMER_MODULES = new Set(
  ["worker.ts", "outboundWorker.ts", "sbomWorker.ts"].map((file) =>
    path.join(root, "src/lib/queue", file),
  ),
);

/** The only module allowed to import them. */
const ENTRY_POINT = path.join(root, "scripts/start-worker.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Static and dynamic import specifiers in a file, resolved to source paths where local. */
function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = [
    ...source.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)["']([^"']+)["']/gm),
  ].map((match) => match[1]);

  return specifiers.flatMap((specifier) => {
    let base: string;
    if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.resolve(path.dirname(file), specifier);
    else return [];
    return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  });
}

describe("queue consumer imports", () => {
  it("importing the scan engine and the scan pool starts no BullMQ consumer", async () => {
    vi.resetModules();
    await import("@/lib/scanner/scanEngine");
    await import("./workerPool");

    expect(constructed).toEqual([]);
  }, 30_000);

  it("only the worker entry point imports a module that starts a consumer", () => {
    const files = [
      ...sourceFiles(path.join(root, "src")),
      ...sourceFiles(path.join(root, "scripts")),
    ];

    const offenders = files
      .filter((file) => file !== ENTRY_POINT && !CONSUMER_MODULES.has(file))
      .filter((file) => localImports(file).some((target) => CONSUMER_MODULES.has(target)))
      .map((file) => path.relative(root, file).split(path.sep).join("/"));

    expect(offenders).toEqual([]);
  });

  it("the static check recognises the entry point's imports", () => {
    // Guards the check itself: if the resolver stopped matching, the test
    // above would pass with nothing checked.
    const fromEntryPoint = localImports(ENTRY_POINT).filter((target) =>
      CONSUMER_MODULES.has(target),
    );
    expect(new Set(fromEntryPoint)).toEqual(CONSUMER_MODULES);
  });
});
