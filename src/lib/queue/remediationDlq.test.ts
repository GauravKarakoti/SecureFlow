import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  enqueueUnverifiedRemediationIntent,
  getUnverifiedRemediationIntents,
  clearRemediationDlq,
  replayUnverifiedRemediationIntents,
  createRemediationDlqWorker,
  isArmorIQBreakerOpen,
  inspectRemediationDlqPayloads,
  retriggerQuarantinedPayload,
  getDlqTelemetryMetrics,
  resetDlqTelemetryMetrics,
  calculateDlqExponentialBackoff,
  REMEDIATION_DLQ_NAME,
} from "./remediationDlq";
import { tripModelCircuitBreaker, resetModelCircuitBreakers } from "@/ai/resilience";
import { ARMORIQ_BREAKER_KEY } from "@/lib/armor/armoriq-breaker";
import { AUDIT_LOG_GENESIS_HASH } from "@/lib/audit/audit-chain";
import { verifyAuditChain } from "@/lib/audit/verify-chain";

describe("src/lib/queue/remediationDlq (#1751, #1765)", () => {
  let mockAuditLogs: any[] = [];
  let mockDb: any;

  beforeEach(async () => {
    await clearRemediationDlq();
    resetModelCircuitBreakers();
    resetDlqTelemetryMetrics();
    mockAuditLogs = [];

    mockDb = {
      auditLog: {
        findFirst: vi.fn(async () => {
          if (mockAuditLogs.length === 0) return null;
          return mockAuditLogs[mockAuditLogs.length - 1];
        }),
        findMany: vi.fn(async () => [...mockAuditLogs]),
        create: vi.fn(async ({ data }: any) => {
          const entry = { id: `audit-${mockAuditLogs.length + 1}`, ...data };
          mockAuditLogs.push(entry);
          return entry;
        }),
      },
    };
  });

  afterEach(async () => {
    await clearRemediationDlq();
    resetModelCircuitBreakers();
    resetDlqTelemetryMetrics();
  });

  it("enqueues unverified remediation intent and assigns a unique jobId", async () => {
    const res = await enqueueUnverifiedRemediationIntent({
      type: "single",
      userId: "user-123",
      findingId: "finding-abc",
      owner: "acme",
      repo: "app",
      fileLocation: "src/auth.ts",
      patchDiff: "diff --git",
      failedReason: "ArmorIQ circuit open",
    });

    expect(res.queue).toBe(REMEDIATION_DLQ_NAME);
    expect(res.jobId).toMatch(/^rem-dlq-/);

    const queued = await getUnverifiedRemediationIntents();
    expect(queued.length).toBe(1);
    expect(queued[0].id).toBe(res.jobId);
    expect(queued[0].findingId).toBe("finding-abc");
    expect(queued[0].status).toBe("queued");
  });

  it("enqueues bulk remediation intents with multiple findingIds", async () => {
    const res = await enqueueUnverifiedRemediationIntent({
      type: "bulk",
      userId: "user-456",
      findingIds: ["f-1", "f-2", "f-3"],
      failedReason: "ArmorIQ timeout",
    });

    expect(res.jobId).toBeDefined();
    const queued = await getUnverifiedRemediationIntents();
    expect(queued.length).toBe(1);
    expect(queued[0].findingIds).toEqual(["f-1", "f-2", "f-3"]);
  });

  it("defers replay when the ArmorIQ circuit breaker is OPEN", async () => {
    await enqueueUnverifiedRemediationIntent({
      type: "single",
      userId: "user-1",
      findingId: "f-1",
    });

    tripModelCircuitBreaker(ARMORIQ_BREAKER_KEY);
    expect(isArmorIQBreakerOpen()).toBe(true);

    const replayRes = await replayUnverifiedRemediationIntents({ dbClient: mockDb });
    expect(replayRes.breakerOpen).toBe(true);
    expect(replayRes.replayed).toBe(0);
    expect(replayRes.pending).toBe(1);
    expect(replayRes.outcomes[0].status).toBe("skipped_breaker_open");
  });

  it("replays queued intents once healthy and appends cryptographically chained audit logs", async () => {
    await enqueueUnverifiedRemediationIntent({
      type: "single",
      userId: "user-1",
      findingId: "f-1",
      fileLocation: "src/api.ts",
      token: { rawToken: {}, planHash: "h1" },
    });
    await enqueueUnverifiedRemediationIntent({
      type: "bulk",
      userId: "user-1",
      findingIds: ["f-2", "f-3"],
      token: { rawToken: {}, planHash: "h2" },
    });

    const verifyMock = vi.fn().mockResolvedValue({ valid: true, unavailable: false });

    const replayRes = await replayUnverifiedRemediationIntents({
      dbClient: mockDb,
      verifyIntentTokenFn: verifyMock,
    });

    expect(replayRes.replayed).toBe(2);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.pending).toBe(0);
    expect(mockAuditLogs.length).toBe(2);

    // Verify first log chained from genesis
    expect(mockAuditLogs[0].previousHash).toBe(AUDIT_LOG_GENESIS_HASH);
    expect(mockAuditLogs[0].entryHash).toBeDefined();

    // Verify second log chained from first log's entryHash
    expect(mockAuditLogs[1].previousHash).toBe(mockAuditLogs[0].entryHash);
    expect(mockAuditLogs[1].entryHash).toBeDefined();

    // Verify audit log chain validation passes scripts/verify-audit-chain checks
    const chainVerification = await verifyAuditChain(mockDb);
    expect(chainVerification.valid).toBe(true);
    expect(chainVerification.totalVerified).toBe(2);

    // DLQ should now be drained of replayed intents
    const remaining = await getUnverifiedRemediationIntents();
    expect(remaining.length).toBe(0);
  });

  it("handles verification failure on replay gracefully", async () => {
    await enqueueUnverifiedRemediationIntent({
      type: "single",
      userId: "user-1",
      findingId: "f-bad",
      token: { rawToken: {} },
    });

    const verifyMock = vi
      .fn()
      .mockResolvedValue({ valid: false, unavailable: false, reason: "Signature mismatch" });

    const replayRes = await replayUnverifiedRemediationIntents({
      dbClient: mockDb,
      verifyIntentTokenFn: verifyMock,
    });

    expect(replayRes.replayed).toBe(0);
    expect(replayRes.failed).toBe(1);
    expect(replayRes.outcomes[0].status).toBe("failed");
    expect(mockAuditLogs.length).toBe(0);
  });

  it("worker periodically ticks and drains when recovered", async () => {
    await enqueueUnverifiedRemediationIntent({
      type: "single",
      userId: "user-1",
      findingId: "f-worker",
      token: { rawToken: {} },
    });

    const worker = createRemediationDlqWorker({
      intervalMs: 100,
      dbClient: mockDb,
      verifyIntentTokenFn: vi.fn().mockResolvedValue({ valid: true, unavailable: false }),
    });

    worker.start();
    await worker.drainOnce();
    await worker.stop();

    expect(mockAuditLogs.length).toBe(1);
    expect(mockAuditLogs[0].action).toBe("ARMORIQ_REMEDIATION_INTENT_VERIFIED");
  });

  describe("Automated DLQ Replay Mechanism and Telemetry (#1765)", () => {
    it("calculates exponential backoff delay with bounded limits", () => {
      const delay1 = calculateDlqExponentialBackoff(1, 1000, 30000);
      const delay2 = calculateDlqExponentialBackoff(2, 1000, 30000);
      const delay3 = calculateDlqExponentialBackoff(3, 1000, 30000);

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay3).toBeGreaterThanOrEqual(4000);

      // Verify upper limit bounding
      const delayMax = calculateDlqExponentialBackoff(10, 1000, 30000);
      expect(delayMax).toBeLessThanOrEqual(30000);
    });

    it("applies exponential backoff on retryable failures and quarantines after maxRetries", async () => {
      await enqueueUnverifiedRemediationIntent({
        type: "single",
        userId: "user-retry",
        findingId: "f-retry",
        maxRetries: 3,
        token: { rawToken: {} },
      });

      const failingVerify = vi.fn().mockResolvedValue({ valid: false, unavailable: false, reason: "Temporary mismatch" });

      // Attempt 1: should record attempt 1 and schedule backoff
      const res1 = await replayUnverifiedRemediationIntents({
        dbClient: mockDb,
        verifyIntentTokenFn: failingVerify,
      });
      expect(res1.failed).toBe(1);
      expect(res1.outcomes[0].retryCount).toBe(1);

      // Attempt 2: fast-forward time to simulate backoff elapsed
      const res2 = await replayUnverifiedRemediationIntents({
        dbClient: mockDb,
        verifyIntentTokenFn: failingVerify,
        nowMs: Date.now() + 100000,
      });
      expect(res2.failed).toBe(1);
      expect(res2.outcomes[0].retryCount).toBe(2);

      // Attempt 3: should exceed maxRetries and quarantine
      const res3 = await replayUnverifiedRemediationIntents({
        dbClient: mockDb,
        verifyIntentTokenFn: failingVerify,
        nowMs: Date.now() + 200000,
      });
      expect(res3.quarantined).toBe(1);
      expect(res3.outcomes[0].status).toBe("quarantined");

      // Verify telemetry tracks the quarantined event
      const telemetry = getDlqTelemetryMetrics();
      expect(telemetry.totalQuarantined).toBe(1);
      expect(telemetry.totalRetries).toBe(3);
      expect(telemetry.quarantinedEvents.length).toBe(1);
      expect(telemetry.quarantinedEvents[0].reason).toContain("Exceeded max retry threshold");
    });

    it("inspects and retriggers quarantined payloads back to active queue", async () => {
      const { jobId } = await enqueueUnverifiedRemediationIntent({
        type: "single",
        userId: "user-admin",
        findingId: "f-quarantine",
        maxRetries: 1,
        token: { rawToken: {} },
      });

      // Cause quarantine
      await replayUnverifiedRemediationIntents({
        dbClient: mockDb,
        verifyIntentTokenFn: vi.fn().mockResolvedValue({ valid: false, unavailable: false }),
      });

      let status = await inspectRemediationDlqPayloads();
      expect(status.quarantined.length).toBe(1);
      expect(status.queued.length).toBe(0);

      // Admin retrigger command
      const retriggerRes = await retriggerQuarantinedPayload(jobId);
      expect(retriggerRes.success).toBe(true);

      status = await inspectRemediationDlqPayloads();
      expect(status.quarantined.length).toBe(0);
      expect(status.queued.length).toBe(1);

      // Next replay succeeds
      const replayRes = await replayUnverifiedRemediationIntents({
        dbClient: mockDb,
        verifyIntentTokenFn: vi.fn().mockResolvedValue({ valid: true, unavailable: false }),
      });
      expect(replayRes.replayed).toBe(1);
      expect(replayRes.outcomes[0].status).toBe("verified");
    });
  });
});
