import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDefaultRedisSet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/redis", () => ({
  redis: {
    set: mockDefaultRedisSet,
  },
}));

import {
  recordWebhookDelivery,
  isDuplicateDelivery,
  webhookDeliveryKey,
  WEBHOOK_DELIVERY_TTL_SECONDS,
  WEBHOOK_DELIVERY_KEY_PREFIX,
} from "./webhook-dedup";

describe("webhook-dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants & key derivation", () => {
    it("uses a 24-hour TTL (86,400 seconds)", () => {
      expect(WEBHOOK_DELIVERY_TTL_SECONDS).toBe(86_400);
    });

    it("uses the 'webhook:delivery:' prefix", () => {
      expect(WEBHOOK_DELIVERY_KEY_PREFIX).toBe("webhook:delivery:");
    });

    it("derives the Redis key using webhookDeliveryKey", () => {
      expect(webhookDeliveryKey("del-12345")).toBe("webhook:delivery:del-12345");
    });
  });

  describe("recordWebhookDelivery", () => {
    it("calls Redis set with atomic set-if-absent (EX 86400 NX)", async () => {
      const mockClient = {
        set: vi.fn().mockResolvedValue("OK"),
      };

      const result = await recordWebhookDelivery("delivery-abc-1", mockClient);

      expect(mockClient.set).toHaveBeenCalledTimes(1);
      expect(mockClient.set).toHaveBeenCalledWith(
        "webhook:delivery:delivery-abc-1",
        "1",
        "EX",
        86_400,
        "NX",
      );
      expect(result).toEqual({ isDuplicate: false, recorded: true });
    });

    it("returns isDuplicate: false, recorded: true on first delivery", async () => {
      const mockClient = {
        set: vi.fn().mockResolvedValue("OK"),
      };

      const result = await recordWebhookDelivery("del-new-1", mockClient);
      expect(result).toEqual({ isDuplicate: false, recorded: true });
    });

    it("returns isDuplicate: true, recorded: false on repeat delivery (Redis returns null)", async () => {
      const mockClient = {
        set: vi.fn().mockResolvedValue(null),
      };

      const result = await recordWebhookDelivery("del-repeat-1", mockClient);
      expect(result).toEqual({ isDuplicate: true, recorded: false });
    });

    it("handles multiple calls: first succeeds, second is detected as duplicate", async () => {
      const storage = new Set<string>();
      const mockClient = {
        set: vi.fn(async (key: string, _val: string, _ex: string, _ttl: number, nx?: string) => {
          if (nx === "NX") {
            if (storage.has(key)) return null;
            storage.add(key);
            return "OK";
          }
          storage.add(key);
          return "OK";
        }),
      };

      const deliveryId = "del-shared-id-1";

      const first = await recordWebhookDelivery(deliveryId, mockClient);
      expect(first).toEqual({ isDuplicate: false, recorded: true });

      const second = await recordWebhookDelivery(deliveryId, mockClient);
      expect(second).toEqual({ isDuplicate: true, recorded: false });
    });

    it("allows different delivery IDs for the same PR without collision", async () => {
      const storage = new Set<string>();
      const mockClient = {
        set: vi.fn(async (key: string, _val: string, _ex: string, _ttl: number, nx?: string) => {
          if (nx === "NX") {
            if (storage.has(key)) return null;
            storage.add(key);
            return "OK";
          }
          storage.add(key);
          return "OK";
        }),
      };

      const res1 = await recordWebhookDelivery("delivery-pr-event-1", mockClient);
      const res2 = await recordWebhookDelivery("delivery-pr-event-2", mockClient);

      expect(res1).toEqual({ isDuplicate: false, recorded: true });
      expect(res2).toEqual({ isDuplicate: false, recorded: true });
      expect(mockClient.set).toHaveBeenCalledTimes(2);
      expect(mockClient.set).toHaveBeenNthCalledWith(
        1,
        "webhook:delivery:delivery-pr-event-1",
        "1",
        "EX",
        86_400,
        "NX",
      );
      expect(mockClient.set).toHaveBeenNthCalledWith(
        2,
        "webhook:delivery:delivery-pr-event-2",
        "1",
        "EX",
        86_400,
        "NX",
      );
    });

    it("fails open when Redis client is null or undefined", async () => {
      const resultNull = await recordWebhookDelivery("del-no-redis", null);
      expect(resultNull).toEqual({ isDuplicate: false, recorded: false });
    });

    it("fails open and logs warning when Redis set rejects", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockClient = {
        set: vi.fn().mockRejectedValue(new Error("ECONNREFUSED: Redis down")),
      };

      const result = await recordWebhookDelivery("del-redis-down", mockClient);

      expect(result).toEqual({ isDuplicate: false, recorded: false });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[WEBHOOK_DEDUPE] Redis error checking delivery del-redis-down"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("returns isDuplicate: false when delivery ID is empty or invalid", async () => {
      const mockClient = { set: vi.fn() };

      expect(await recordWebhookDelivery("", mockClient)).toEqual({
        isDuplicate: false,
        recorded: false,
      });
      expect(await recordWebhookDelivery("   ", mockClient)).toEqual({
        isDuplicate: false,
        recorded: false,
      });
      expect(await recordWebhookDelivery(null as unknown as string, mockClient)).toEqual({
        isDuplicate: false,
        recorded: false,
      });
      expect(mockClient.set).not.toHaveBeenCalled();
    });

    it("trims whitespace from delivery ID before creating key", async () => {
      const mockClient = {
        set: vi.fn().mockResolvedValue("OK"),
      };

      await recordWebhookDelivery("  del-with-spaces  ", mockClient);
      expect(mockClient.set).toHaveBeenCalledWith(
        "webhook:delivery:del-with-spaces",
        "1",
        "EX",
        86_400,
        "NX",
      );
    });

    it("uses default redis instance when no client argument is supplied", async () => {
      mockDefaultRedisSet.mockResolvedValueOnce("OK");

      const result = await recordWebhookDelivery("del-default-client");

      expect(mockDefaultRedisSet).toHaveBeenCalledWith(
        "webhook:delivery:del-default-client",
        "1",
        "EX",
        86_400,
        "NX",
      );
      expect(result).toEqual({ isDuplicate: false, recorded: true });
    });
  });

  describe("isDuplicateDelivery", () => {
    it("returns false for first delivery", async () => {
      const mockClient = {
        set: vi.fn().mockResolvedValue("OK"),
      };

      const isDup = await isDuplicateDelivery("del-dup-test-1", mockClient);
      expect(isDup).toBe(false);
    });

    it("returns true for repeated delivery", async () => {
      const mockClient = {
        set: vi.fn().mockResolvedValue(null),
      };

      const isDup = await isDuplicateDelivery("del-dup-test-1", mockClient);
      expect(isDup).toBe(true);
    });

    it("returns false (fails open) when Redis throws", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockClient = {
        set: vi.fn().mockRejectedValue(new Error("Redis timeout")),
      };

      const isDup = await isDuplicateDelivery("del-timeout", mockClient);
      expect(isDup).toBe(false);
    });

    it("returns false for empty delivery ID", async () => {
      const mockClient = { set: vi.fn() };
      const isDup = await isDuplicateDelivery("", mockClient);
      expect(isDup).toBe(false);
      expect(mockClient.set).not.toHaveBeenCalled();
    });
  });
});
