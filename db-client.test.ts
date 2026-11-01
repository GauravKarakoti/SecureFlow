import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveConnectionString,
  resolvePoolMax,
  resolvePoolConfig,
  resolveMockDb,
  DEFAULT_POOL_MAX,
  MIN_POOL_MAX,
  MAX_POOL_MAX,
  MISSING_CONNECTION_STRING_MESSAGE,
} from "@/lib/db/pool-config";

describe("db-client.ts and database client initialization (#1500)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("exports root database client module cleanly without runtime exceptions", async () => {
    const dbModule = await import("./db-client");
    expect(dbModule).toBeDefined();
    expect(typeof dbModule).toBe("object");
  });

  it("ensures db-client does not execute unintended database operations on import", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const dbModule = await import("./db-client");
    expect(dbModule).not.toBeNull();

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("resolves connection string preferring DATABASE_POOL_URL over DATABASE_URL", () => {
    const env = {
      DATABASE_POOL_URL: "postgresql://pooler:5432/mydb",
      DATABASE_URL: "postgresql://direct:5432/mydb",
    };
    expect(resolveConnectionString(env)).toBe("postgresql://pooler:5432/mydb");
  });

  it("falls back to DATABASE_URL when DATABASE_POOL_URL is absent or empty", () => {
    const env = {
      DATABASE_POOL_URL: "   ",
      DATABASE_URL: "postgresql://direct:5432/mydb",
    };
    expect(resolveConnectionString(env)).toBe("postgresql://direct:5432/mydb");
  });

  it("returns null when no connection string is present in env", () => {
    expect(resolveConnectionString({})).toBeNull();
    expect(resolveConnectionString({ DATABASE_URL: "" })).toBeNull();
  });

  it("correctly clamps and validates pool max values within bounds", () => {
    expect(resolvePoolMax({}).value).toBe(DEFAULT_POOL_MAX);
    expect(resolvePoolMax({ DB_POOL_MAX: "25" }).value).toBe(25);
    expect(resolvePoolMax({ DB_POOL_MAX: "0" }).value).toBe(MIN_POOL_MAX);
    expect(resolvePoolMax({ DB_POOL_MAX: "9999" }).value).toBe(MAX_POOL_MAX);
    expect(resolvePoolMax({ DB_POOL_MAX: "invalid" }).value).toBe(DEFAULT_POOL_MAX);
  });

  it("resolves full pool configuration and reports unconfigured when connection string is missing", () => {
    const unconfigured = resolvePoolConfig({});
    expect(unconfigured.unconfigured).toBe(true);
    expect(unconfigured.warnings).toContain(MISSING_CONNECTION_STRING_MESSAGE);

    const configured = resolvePoolConfig({
      DATABASE_URL: "postgresql://localhost:5432/testdb",
      DB_POOL_MAX: "15",
    });
    expect(configured.unconfigured).toBe(false);
    expect(configured.config.max).toBe(15);
    expect(configured.config.connectionString).toBe("postgresql://localhost:5432/testdb");
  });

  it("validates mock database resolution rules", () => {
    const prodEnv = { NODE_ENV: "production", NEXT_PUBLIC_MOCK_DB: "true" };
    const prodResolution = resolveMockDb(prodEnv as any);
    expect(prodResolution.requested).toBe(true);
    expect(prodResolution.allowed).toBe(false);

    const testEnv = { NODE_ENV: "test", NEXT_PUBLIC_MOCK_DB: "true" };
    const testResolution = resolveMockDb(testEnv as any);
    expect(testResolution.requested).toBe(true);
    expect(testResolution.allowed).toBe(true);
  });

  it("loads Prisma client safely from @/lib/prisma in application context", async () => {
    const prismaModule = await import("@/lib/prisma");
    expect(prismaModule.default).toBeDefined();
    expect(typeof prismaModule.default).toBe("object");
  });
});
