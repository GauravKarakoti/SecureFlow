import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveWebhookSecrets,
  recordWebhookSecretRotation,
  resetInMemoryWebhookSecretStore,
  WEBHOOK_SECRET_CURRENT_KEY,
  WEBHOOK_SECRET_PREVIOUS_KEY,
  DEFAULT_WEBHOOK_SECRET_GRACE_PERIOD_SECONDS,
} from "./webhook-secret-store";

describe("webhook-secret-store", () => {
  beforeEach(() => {
    resetInMemoryWebhookSecretStore();
    vi.clearAllMocks();
  });

  describe("in-memory resolution", () => {
    it("returns configured secret as current with no previous on initial setup", async () => {
      const result = await resolveWebhookSecrets("secret-one", null);
      expect(result).toEqual({ current: "secret-one", previous: null });
    });

    it("automatically preserves previous secret in memory when rotation is detected", async () => {
      await resolveWebhookSecrets("secret-initial", null);

      // Now configured secret changes to new secret
      const result = await resolveWebhookSecrets("secret-rotated", null);
      expect(result).toEqual({ current: "secret-rotated", previous: "secret-initial" });

      // Subsequent call keeps the previous secret during grace period
      const nextCall = await resolveWebhookSecrets("secret-rotated", null);
      expect(nextCall).toEqual({ current: "secret-rotated", previous: "secret-initial" });
    });

    it("expires previous secret after grace period", async () => {
      vi.useFakeTimers();
      try {
        await resolveWebhookSecrets("secret-v1", null, 60);
        await resolveWebhookSecrets("secret-v2", null, 60);

        // Advance past 60 seconds grace period
        vi.advanceTimersByTime(61 * 1000);

        const result = await resolveWebhookSecrets("secret-v2", null, 60);
        expect(result).toEqual({ current: "secret-v2", previous: null });
      } finally {
        vi.useRealTimers();
      }
    });

    it("parses comma-separated secrets if pinned in single environment variable", async () => {
      const result = await resolveWebhookSecrets("new-secret,old-secret", null);
      expect(result).toEqual({ current: "new-secret", previous: "old-secret" });
    });

    it("returns empty string and null for empty configured secret", async () => {
      const result = await resolveWebhookSecrets("", null);
      expect(result).toEqual({ current: "", previous: null });
    });
  });

  describe("Redis-backed resolution", () => {
    it("stores current secret on initial setup when Redis has no record", async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue("OK"),
      };

      const result = await resolveWebhookSecrets("redis-secret-1", mockRedis as any);
      expect(result).toEqual({ current: "redis-secret-1", previous: null });
      expect(mockRedis.set).toHaveBeenCalledWith(WEBHOOK_SECRET_CURRENT_KEY, "redis-secret-1");
    });

    it("detects rotation in Redis and archives previous secret with TTL", async () => {
      const mockRedis = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === WEBHOOK_SECRET_CURRENT_KEY) return Promise.resolve("old-active-secret");
          if (key === WEBHOOK_SECRET_PREVIOUS_KEY) return Promise.resolve(null);
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue("OK"),
      };

      const result = await resolveWebhookSecrets(
        "new-active-secret",
        mockRedis as any,
        DEFAULT_WEBHOOK_SECRET_GRACE_PERIOD_SECONDS,
      );

      expect(result).toEqual({
        current: "new-active-secret",
        previous: "old-active-secret",
      });
      expect(mockRedis.set).toHaveBeenCalledWith(
        WEBHOOK_SECRET_PREVIOUS_KEY,
        "old-active-secret",
        "EX",
        DEFAULT_WEBHOOK_SECRET_GRACE_PERIOD_SECONDS,
      );
      expect(mockRedis.set).toHaveBeenCalledWith(WEBHOOK_SECRET_CURRENT_KEY, "new-active-secret");
    });

    it("returns existing previous secret from Redis when secret has not changed", async () => {
      const mockRedis = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === WEBHOOK_SECRET_CURRENT_KEY) return Promise.resolve("current-secret");
          if (key === WEBHOOK_SECRET_PREVIOUS_KEY)
            return Promise.resolve("previous-secret-in-grace");
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue("OK"),
      };

      const result = await resolveWebhookSecrets("current-secret", mockRedis as any);
      expect(result).toEqual({
        current: "current-secret",
        previous: "previous-secret-in-grace",
      });
    });

    it("programmatically records secret rotation into Redis and memory", async () => {
      const mockRedis = {
        get: vi.fn(),
        set: vi.fn().mockResolvedValue("OK"),
      };

      await recordWebhookSecretRotation("secret-new", "secret-old", mockRedis as any, 3600);

      expect(mockRedis.set).toHaveBeenCalledWith(
        WEBHOOK_SECRET_PREVIOUS_KEY,
        "secret-old",
        "EX",
        3600,
      );
      expect(mockRedis.set).toHaveBeenCalledWith(WEBHOOK_SECRET_CURRENT_KEY, "secret-new");
    });
  });
});
