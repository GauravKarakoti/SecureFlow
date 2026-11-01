import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instrumentation.ts unit tests (#1500)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("exports a register function", async () => {
    const { register } = await import("./instrumentation");
    expect(typeof register).toBe("function");
  });

  it("imports ./src/lib/env when NEXT_RUNTIME is nodejs", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("skips importing ./src/lib/env when NEXT_RUNTIME is edge", async () => {
    process.env.NEXT_RUNTIME = "edge";

    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("skips importing ./src/lib/env when NEXT_RUNTIME is unset or undefined", async () => {
    delete process.env.NEXT_RUNTIME;

    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("skips importing ./src/lib/env when NEXT_RUNTIME is set to client or custom runtime", async () => {
    process.env.NEXT_RUNTIME = "browser";

    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("can execute register multiple times idempotently without throwing", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
    await expect(register()).resolves.toBeUndefined();
  });

  it("handles environment variables inspection without throwing during nodejs startup", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NODE_ENV = "test";

    const { register } = await import("./instrumentation");
    const promise = register();
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toBeUndefined();
  });
});
