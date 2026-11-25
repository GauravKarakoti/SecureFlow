import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AuditStreamManager,
  sanitizeEventForStream,
  createBatchManifest,
  type AuditStreamEvent,
  type AuditBatchPayload,
} from "./audit-sink";

describe("Audit Event Stream Sink (#2097)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Sanitization: Never include snippets or secrets in streamed events", () => {
    it("strips secrets and code snippets from metadata", () => {
      const rawEvent: AuditStreamEvent = {
        action: "SCAN_COMPLETED",
        resource: "acme/repo#42",
        decision: "BLOCKED",
        timestamp: new Date("2026-11-26T00:00:00Z"),
        metadata: {
          prNumber: 42,
          findingsCount: 3,
          codeSnippet: "const apiKey = 'sk-secret-123456789';",
          snippet: "password = 'super_secret';",
          token: "ghp_xxxxxxxxxxxxxxxxxxxx",
          password: "mySecretPassword123",
          secret: "production-aws-key",
          apiKey: "sk-proj-xyz",
          rawResponse: "AI response with raw diff...",
          patch: "diff --git a/test.ts...",
          diff: "+ added line",
          safeContext: "non-sensitive-data",
        },
      };

      const sanitized = sanitizeEventForStream(rawEvent);

      expect(sanitized.action).toBe("SCAN_COMPLETED");
      expect(sanitized.resource).toBe("acme/repo#42");
      expect(sanitized.metadata.prNumber).toBe(42);
      expect(sanitized.metadata.findingsCount).toBe(3);
      expect(sanitized.metadata.safeContext).toBe("non-sensitive-data");

      // Verify forbidden keys are completely stripped
      expect(sanitized.metadata.codeSnippet).toBeUndefined();
      expect(sanitized.metadata.snippet).toBeUndefined();
      expect(sanitized.metadata.token).toBeUndefined();
      expect(sanitized.metadata.password).toBeUndefined();
      expect(sanitized.metadata.secret).toBeUndefined();
      expect(sanitized.metadata.apiKey).toBeUndefined();
      expect(sanitized.metadata.rawResponse).toBeUndefined();
      expect(sanitized.metadata.patch).toBeUndefined();
      expect(sanitized.metadata.diff).toBeUndefined();

      // Check SHA-256 contentHash exists
      expect(sanitized.contentHash).toBeDefined();
      expect(sanitized.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("sanitizes nested metadata objects recursively", () => {
      const rawEvent: AuditStreamEvent = {
        action: "FINDING_TRIAGE",
        resource: "repo:fp123",
        timestamp: new Date(),
        metadata: {
          nested: {
            safeKey: "safeValue",
            secret: "nestedSecret",
            apiKey: "nestedApiKey",
          },
        },
      };

      const sanitized = sanitizeEventForStream(rawEvent);
      const nested = sanitized.metadata.nested as Record<string, unknown>;
      expect(nested.safeKey).toBe("safeValue");
      expect(nested.secret).toBeUndefined();
      expect(nested.apiKey).toBeUndefined();
    });
  });

  describe("Manifest Signing: Sign batch files with a hash manifest", () => {
    it("creates valid SHA-256 manifest signing all events in batch", () => {
      const events = [
        sanitizeEventForStream({ action: "A", resource: "r1", timestamp: new Date() }),
        sanitizeEventForStream({ action: "B", resource: "r2", timestamp: new Date() }),
      ];

      const manifest = createBatchManifest(events, "batch-101", 1, "test-signing-key");

      expect(manifest.version).toBe("1.0");
      expect(manifest.batchId).toBe("batch-101");
      expect(manifest.eventCount).toBe(2);
      expect(manifest.sequenceStart).toBe(1);
      expect(manifest.sequenceEnd).toBe(2);
      expect(manifest.eventsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.manifestSignature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("Ordering and Retries: Events reach sink in order with retries on failure", () => {
    it("delivers events in order to fake sink transport", async () => {
      const receivedBatches: AuditBatchPayload[] = [];
      const manager = new AuditStreamManager({
        enabled: true,
        batchSize: 2,
        flushIntervalMs: 0,
      });

      manager.customTransport = async (batch) => {
        receivedBatches.push(batch);
      };

      manager.enqueue({ action: "EVENT_1", resource: "res1", timestamp: new Date() });
      manager.enqueue({ action: "EVENT_2", resource: "res2", timestamp: new Date() });
      await manager.flush();

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0].events).toHaveLength(2);
      expect(receivedBatches[0].events[0].action).toBe("EVENT_1");
      expect(receivedBatches[0].events[1].action).toBe("EVENT_2");
      expect(receivedBatches[0].manifest.sequenceStart).toBe(1);
      expect(receivedBatches[0].manifest.sequenceEnd).toBe(2);
    });

    it("retries upon failure and succeeds when sink recovers", async () => {
      let attempts = 0;
      const manager = new AuditStreamManager({
        enabled: true,
        batchSize: 1,
        maxRetries: 3,
        flushIntervalMs: 0,
      });

      manager.customTransport = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("Temporary S3 / Network 503 error");
        }
      };

      manager.enqueue({ action: "RETRY_EVENT", resource: "res", timestamp: new Date() });
      const success = await manager.flush();

      expect(success).toBe(true);
      expect(attempts).toBe(2);
      expect(manager.getHealth().status).toBe("HEALTHY");
      expect(manager.getHealth().totalSent).toBe(1);
      expect(manager.getHealth().bufferedCount).toBe(0);
    });
  });

  describe("Non-Blocking Failure: A failing sink never blocks scans", () => {
    it("handles persistent sink failure without throwing or halting execution", async () => {
      const manager = new AuditStreamManager({
        enabled: true,
        batchSize: 1,
        maxRetries: 1,
        flushIntervalMs: 0,
      });

      manager.customTransport = async () => {
        throw new Error("Persistent S3 500 Outage");
      };

      manager.enqueue({ action: "FAIL_EVENT", resource: "res", timestamp: new Date() });

      // Flushing should resolve to false, NEVER throw an unhandled exception
      let flushThrew = false;
      try {
        const success = await manager.flush();
        expect(success).toBe(false);
      } catch {
        flushThrew = true;
      }

      expect(flushThrew).toBe(false);
      const health = manager.getHealth();
      expect(health.status).toBe("DEGRADED");
      expect(health.lastError).toContain("Persistent S3 500 Outage");
      expect(health.consecutiveFailures).toBe(1);
    });

    it("drops oldest events when local buffer limit is reached to protect memory", () => {
      const manager = new AuditStreamManager({
        enabled: true,
        bufferLimit: 3,
        batchSize: 10,
        flushIntervalMs: 0,
      });

      manager.enqueue({ action: "EVT_1", resource: "r1", timestamp: new Date() });
      manager.enqueue({ action: "EVT_2", resource: "r2", timestamp: new Date() });
      manager.enqueue({ action: "EVT_3", resource: "r3", timestamp: new Date() });
      // Exceeds limit 3
      manager.enqueue({ action: "EVT_4", resource: "r4", timestamp: new Date() });

      const buffered = manager.getBufferedEvents();
      expect(buffered).toHaveLength(3);
      expect(buffered[0].action).toBe("EVT_2"); // EVT_1 dropped
      expect(buffered[2].action).toBe("EVT_4");
    });
  });

  describe("Sink Health Status", () => {
    it("reports DISABLED when sink is not enabled", () => {
      const manager = new AuditStreamManager({ enabled: false });
      expect(manager.getHealth().status).toBe("DISABLED");
    });

    it("reports FAILING after consecutive failures", async () => {
      const manager = new AuditStreamManager({
        enabled: true,
        batchSize: 1,
        maxRetries: 0,
        flushIntervalMs: 0,
      });

      manager.customTransport = async () => {
        throw new Error("Connection refused");
      };

      for (let i = 0; i < 3; i++) {
        manager.enqueue({ action: `EVT_${i}`, resource: "res", timestamp: new Date() });
        await manager.flush();
      }

      expect(manager.getHealth().status).toBe("FAILING");
      expect(manager.getHealth().consecutiveFailures).toBe(3);
    });
  });
});
