import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Unmock @/lib/prisma so this file can test the module itself
vi.unmock("./prisma");
vi.unmock("@/lib/prisma");

/**
 * Mock PrismaClient and pg pool infrastructure, matching the pattern in prisma.pool.test.ts.
 */
const { FakePrismaClient, constructedClients } = vi.hoisted(() => {
  interface MockPrismaClientInstance {
    options: Record<string, unknown>;
    listeners: Map<string, ((...args: unknown[]) => void)[]>;
  }

  const constructedClients: MockPrismaClientInstance[] = [];

  class FakePrismaClient {
    public readonly options: Record<string, unknown>;
    public readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      constructedClients.push(this);
    }

    $on(event: string, handler: (...args: unknown[]) => void): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(handler);
      this.listeners.set(event, existing);
      return this;
    }
  }

  return { FakePrismaClient, constructedClients };
});

vi.mock("pg", () => ({
  Pool: class {
    on() {
      return this;
    }
  },
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(public pool: unknown) {}
  },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: FakePrismaClient,
}));

import {
  shouldLogQueries,
  resolveSlowQueryThreshold,
  normalizeQuery,
  createRecentQueryTracker,
  handlePrismaQueryEvent,
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  type PrismaQueryEvent,
} from "./prisma";
import type { Logger } from "@/lib/logger";

const ORIGINAL_ENV = { ...process.env };

/** Helper to import prisma.ts with fresh environment and cleared singleton memo */
async function importWithEnv(overrides: Record<string, string | undefined>) {
  for (const key of [
    "DATABASE_URL",
    "DATABASE_POOL_URL",
    "DB_POOL_MAX",
    "NEXT_PUBLIC_MOCK_DB",
    "PRISMA_LOG_QUERIES",
    "SLOW_QUERY_THRESHOLD_MS",
    "NODE_ENV",
    "CI",
    "NEXT_PHASE",
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
  vi.resetModules();
  vi.doUnmock("@/lib/prisma");
  vi.doUnmock("./prisma");
  return import("./prisma");
}

describe("Prisma Development Query Logging & Process-Wide Repeated-Query Detection", () => {
  beforeEach(() => {
    constructedClients.length = 0;
    delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
  });

  describe("shouldLogQueries (Copilot Comment 1: High — Prevent Production Logging)", () => {
    it("returns true when NODE_ENV is development", () => {
      expect(shouldLogQueries({ NODE_ENV: "development" })).toBe(true);
    });

    it("allows opting out in development when PRISMA_LOG_QUERIES is 'false'", () => {
      expect(shouldLogQueries({ NODE_ENV: "development", PRISMA_LOG_QUERIES: "false" })).toBe(
        false,
      );
    });

    it("returns false in production by default", () => {
      expect(shouldLogQueries({ NODE_ENV: "production" })).toBe(false);
    });

    it("NEVER enables query logging in production, even when PRISMA_LOG_QUERIES='true'", () => {
      expect(shouldLogQueries({ NODE_ENV: "production", PRISMA_LOG_QUERIES: "true" })).toBe(false);
    });

    it("returns false in test even when PRISMA_LOG_QUERIES='true'", () => {
      expect(shouldLogQueries({ NODE_ENV: "test", PRISMA_LOG_QUERIES: "true" })).toBe(false);
    });

    it("returns false when NODE_ENV is unset or unknown", () => {
      expect(shouldLogQueries({})).toBe(false);
      expect(shouldLogQueries({ NODE_ENV: "staging" })).toBe(false);
    });
  });

  describe("resolveSlowQueryThreshold", () => {
    it("returns default threshold (100ms) when unset", () => {
      expect(resolveSlowQueryThreshold({})).toBe(DEFAULT_SLOW_QUERY_THRESHOLD_MS);
    });

    it("respects SLOW_QUERY_THRESHOLD_MS env override", () => {
      expect(resolveSlowQueryThreshold({ SLOW_QUERY_THRESHOLD_MS: "250" })).toBe(250);
    });

    it("falls back to default when SLOW_QUERY_THRESHOLD_MS is invalid", () => {
      expect(resolveSlowQueryThreshold({ SLOW_QUERY_THRESHOLD_MS: "invalid" })).toBe(
        DEFAULT_SLOW_QUERY_THRESHOLD_MS,
      );
      expect(resolveSlowQueryThreshold({ SLOW_QUERY_THRESHOLD_MS: "-10" })).toBe(
        DEFAULT_SLOW_QUERY_THRESHOLD_MS,
      );
    });
  });

  describe("normalizeQuery", () => {
    it("collapses multi-line whitespace and trims", () => {
      const raw = `
        SELECT id, name
        FROM "User"
        WHERE id = $1
      `;
      expect(normalizeQuery(raw)).toBe('SELECT id, name FROM "User" WHERE id = $1');
    });
  });

  describe("createRecentQueryTracker (Copilot Comment 2: Medium — Prevent Warning Flooding)", () => {
    it("tracks query occurrences and triggers isRepeated ONLY on threshold-crossing", () => {
      const tracker = createRecentQueryTracker({ windowMs: 2000, threshold: 3 });
      const query = 'SELECT * FROM "Repository" WHERE id = $1';

      const t0 = 10000;

      // 1st occurrence: no warning
      const r1 = tracker.recordQuery(query, t0);
      expect(r1.count).toBe(1);
      expect(r1.isRepeated).toBe(false);

      // 2nd occurrence: no warning
      const r2 = tracker.recordQuery(query, t0 + 200);
      expect(r2.count).toBe(2);
      expect(r2.isRepeated).toBe(false);

      // 3rd occurrence (threshold-crossing): triggers warning
      const r3 = tracker.recordQuery(query, t0 + 400);
      expect(r3.count).toBe(3);
      expect(r3.isRepeated).toBe(true);

      // 4th occurrence in same window: NO repeated warning
      const r4 = tracker.recordQuery(query, t0 + 600);
      expect(r4.count).toBe(4);
      expect(r4.isRepeated).toBe(false);

      // 5th occurrence in same window: NO repeated warning
      const r5 = tracker.recordQuery(query, t0 + 800);
      expect(r5.count).toBe(5);
      expect(r5.isRepeated).toBe(false);
    });

    it("resets warning suppression after the query ages out of the sliding window", () => {
      const tracker = createRecentQueryTracker({ windowMs: 2000, threshold: 3 });
      const query = 'SELECT * FROM "Repository" WHERE id = $1';

      // First sequence: threshold crossed at t = 1400
      tracker.recordQuery(query, 1000);
      tracker.recordQuery(query, 1200);
      const r3 = tracker.recordQuery(query, 1400);
      expect(r3.isRepeated).toBe(true);

      // 4th execution in same window is suppressed
      const r4 = tracker.recordQuery(query, 1600);
      expect(r4.isRepeated).toBe(false);

      // Query ages out of the window (> 2000ms after last execution at 1600ms)
      // Next query at t = 4000ms: cutoff is 2000ms, all prior timestamps [1000..1600] age out
      const r5 = tracker.recordQuery(query, 4000);
      expect(r5.count).toBe(1);
      expect(r5.isRepeated).toBe(false);

      const r6 = tracker.recordQuery(query, 4200);
      expect(r6.count).toBe(2);
      expect(r6.isRepeated).toBe(false);

      // Second sequence crosses threshold again: triggers a fresh warning
      const r7 = tracker.recordQuery(query, 4400);
      expect(r7.count).toBe(3);
      expect(r7.isRepeated).toBe(true);
    });

    it("prevents unbounded memory growth by respecting maxEntries", () => {
      const tracker = createRecentQueryTracker({ maxEntries: 2 });
      tracker.recordQuery("query-1", 1000);
      tracker.recordQuery("query-2", 1000);
      expect(tracker.size()).toBe(2);

      tracker.recordQuery("query-3", 1000);
      expect(tracker.size()).toBeLessThanOrEqual(2);
    });
  });

  describe("handlePrismaQueryEvent (Copilot Comment 4: Process-Wide Repeated-Query Labeling)", () => {
    let tracker: ReturnType<typeof createRecentQueryTracker>;
    let mockLogger: {
      debug: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      tracker = createRecentQueryTracker({ windowMs: 2000, threshold: 3 });
      mockLogger = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
    });

    it("logs regular fast queries at debug level", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "User" WHERE id = $1',
        duration: 15,
      };

      handlePrismaQueryEvent(
        event,
        {
          slowThresholdMs: 100,
          tracker,
          logger: mockLogger as unknown as Logger,
        },
        1000,
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Prisma query (15ms)",
        expect.objectContaining({
          query: event.query,
          durationMs: 15,
        }),
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("never logs raw query bind parameters even when params are provided in the event", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "User" WHERE email = $1 AND passwordHash = $2',
        params: '["sensitive-email@test.com", "$2b$12$e8uqP0..."]',
        duration: 25,
      };

      handlePrismaQueryEvent(
        event,
        {
          slowThresholdMs: 100,
          tracker,
          logger: mockLogger as unknown as Logger,
        },
        1000,
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Prisma query (25ms)",
        expect.not.objectContaining({
          params: expect.anything(),
        }),
      );
      const loggedMeta = mockLogger.debug.mock.calls[0][1];
      expect(loggedMeta).not.toHaveProperty("params");
    });

    it("logs slow queries at warn level", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "AuditLog" ORDER BY timestamp DESC',
        duration: 150,
      };

      handlePrismaQueryEvent(
        event,
        {
          slowThresholdMs: 100,
          tracker,
          logger: mockLogger as unknown as Logger,
        },
        1000,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Slow query detected: 150ms (threshold: 100ms)",
        expect.objectContaining({
          query: event.query,
          durationMs: 150,
        }),
      );
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it("logs repeated queries with explicit 'process-wide' scope and avoids warning flooding on hot queries", () => {
      const event: PrismaQueryEvent = {
        query: 'SELECT * FROM "Repository" WHERE id = $1',
        duration: 20,
      };

      const ctx = {
        slowThresholdMs: 100,
        tracker,
        logger: mockLogger as unknown as Logger,
      };

      // 1st and 2nd executions: debug logs, no warnings
      handlePrismaQueryEvent(event, ctx, 1000);
      handlePrismaQueryEvent(event, ctx, 1200);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledTimes(2);

      // 3rd execution (threshold-crossing): exactly one warning with process-wide label
      handlePrismaQueryEvent(event, ctx, 1400);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Repeated query detected (process-wide 3x in 2000ms): 20ms",
        expect.objectContaining({
          query: event.query,
          durationMs: 20,
          repeatedCount: 3,
          scope: "process-wide",
        }),
      );

      // 4th, 5th, 6th executions in same window: NO additional warnings emitted (prevent flooding)
      handlePrismaQueryEvent(event, ctx, 1500);
      handlePrismaQueryEvent(event, ctx, 1600);
      handlePrismaQueryEvent(event, ctx, 1700);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("PrismaClient Constructor & Event Registration (Copilot Comment 3: Low)", () => {
    it("in development: passes event logging options and registers $on for query/warn/error", async () => {
      await importWithEnv({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://u:p@localhost:5432/secureflow_dev",
      });

      expect(constructedClients).toHaveLength(1);
      const client = constructedClients[0];

      // Verify constructor options
      expect(client.options.log).toEqual([
        { emit: "event", level: "query" },
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ]);

      // Verify $on listeners registered
      expect(client.listeners.has("query")).toBe(true);
      expect(client.listeners.get("query")).toHaveLength(1);
      expect(client.listeners.has("warn")).toBe(true);
      expect(client.listeners.get("warn")).toHaveLength(1);
      expect(client.listeners.has("error")).toBe(true);
      expect(client.listeners.get("error")).toHaveLength(1);
    });

    it("in production: passes error-only event logging and registers error listener through the application logger", async () => {
      await importWithEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://u:p@db.production:5432/secureflow",
      });

      expect(constructedClients).toHaveLength(1);
      const client = constructedClients[0];

      // Verify constructor receives error-only event config (not stdout)
      expect(client.options.log).toEqual([{ emit: "event", level: "error" }]);

      // Verify query and warn listeners are NOT registered in production
      expect(client.listeners.has("query")).toBe(false);
      expect(client.listeners.has("warn")).toBe(false);

      // Verify error listener IS registered so errors pass through the logger's redaction pipeline
      expect(client.listeners.has("error")).toBe(true);
      expect(client.listeners.get("error")).toHaveLength(1);
    });

    it("in production with PRISMA_LOG_QUERIES='true': remains strictly error-only and registers NO query listeners", async () => {
      await importWithEnv({
        NODE_ENV: "production",
        PRISMA_LOG_QUERIES: "true",
        DATABASE_URL: "postgresql://u:p@db.production:5432/secureflow",
      });

      expect(constructedClients).toHaveLength(1);
      const client = constructedClients[0];

      // Production must remain error-only even if someone sets PRISMA_LOG_QUERIES
      expect(client.options.log).toEqual([{ emit: "event", level: "error" }]);
      expect(client.listeners.has("query")).toBe(false);
      expect(client.listeners.has("warn")).toBe(false);
      expect(client.listeners.has("error")).toBe(true);
    });

    it("safely handles PrismaClient mocks where $on is not defined", async () => {
      // Temporarily delete $on from FakePrismaClient prototype
      const originalOn = FakePrismaClient.prototype.$on;
      delete (FakePrismaClient.prototype as { $on?: unknown }).$on;

      try {
        await expect(
          importWithEnv({
            NODE_ENV: "development",
            DATABASE_URL: "postgresql://u:p@localhost:5432/secureflow_dev",
          }),
        ).resolves.toBeDefined();

        expect(constructedClients).toHaveLength(1);
      } finally {
        FakePrismaClient.prototype.$on = originalOn;
      }
    });
  });
});
