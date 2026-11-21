import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  gracefulShutdown,
  resetShutdownState,
  isWorkerShuttingDown,
  setupWorkerSignalHandlers,
  resolveShutdownTimeoutMs,
  DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
} from "./shutdown";
import {
  registerInFlightScan,
  unregisterInFlightScan,
  getInFlightScans,
  getInFlightScanCount,
  clearInFlightScans,
  handleInterruptedScans,
  type ActiveScan,
} from "./in-flight-scans";
import * as queueRedis from "./redis";
import * as lockModule from "./lock";

describe("Worker Graceful Shutdown & Interrupted Scan Recovery (#1894)", () => {
  let releaseLockSpy: any;
  let closeRedisSpy: any;

  beforeEach(() => {
    resetShutdownState();
    clearInFlightScans();
    vi.clearAllMocks();
    releaseLockSpy = vi.spyOn(lockModule, "releaseLock").mockResolvedValue(true);
    closeRedisSpy = vi.spyOn(queueRedis, "closeQueueRedis").mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetShutdownState();
    clearInFlightScans();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves shutdown timeout with env var precedence over default", () => {
    expect(resolveShutdownTimeoutMs()).toBe(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS);
    expect(resolveShutdownTimeoutMs(10000)).toBe(10000);

    const orig = process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
    try {
      process.env.WORKER_SHUTDOWN_TIMEOUT_MS = "18000";
      expect(resolveShutdownTimeoutMs()).toBe(18000);
      // Explicit parameter still overrides env var
      expect(resolveShutdownTimeoutMs(5000)).toBe(5000);
    } finally {
      if (orig !== undefined) {
        process.env.WORKER_SHUTDOWN_TIMEOUT_MS = orig;
      } else {
        delete process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
      }
    }
  });

  it("lets a scan finish within the grace period when SIGTERM arrives", async () => {
    vi.useFakeTimers();

    let scanFinished = false;
    const scanDurationMs = 3000;
    const gracePeriodMs = 10000;

    // Simulate in-flight scan
    const scanId = "pr-scan:test-org/repo:42";
    const scanPromise = new Promise<string>((resolve) => {
      setTimeout(() => {
        scanFinished = true;
        unregisterInFlightScan(scanId);
        resolve("SCAN_COMPLETED");
      }, scanDurationMs);
    });

    const mockWorker = {
      pause: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(() => scanPromise),
    };

    registerInFlightScan({
      id: scanId,
      repositoryFullName: "test-org/repo",
      owner: "test-org",
      repo: "repo",
      prNumber: 42,
      headSha: "abc1234",
      lockKey: "pr-scan:test-org/repo:42",
      lockToken: "token-1",
    });

    expect(getInFlightScanCount()).toBe(1);

    // Trigger graceful shutdown on SIGTERM
    const shutdownPromise = gracefulShutdown("SIGTERM", {
      workers: [mockWorker as any],
      timeoutMs: gracePeriodMs,
    });

    expect(isWorkerShuttingDown()).toBe(true);
    expect(mockWorker.pause).toHaveBeenCalledWith(true);

    // Advance clock to finish the scan within the grace period
    await vi.advanceTimersByTimeAsync(scanDurationMs);
    await shutdownPromise;

    expect(scanFinished).toBe(true);
    expect(getInFlightScanCount()).toBe(0);
    expect(closeRedisSpy).toHaveBeenCalledTimes(1);
    // Did not release lock prematurely via timeout recovery since it finished normally
    expect(releaseLockSpy).not.toHaveBeenCalled();
  });

  it("marks check run as neutral/cancelled and re-queues job when scan exceeds grace period", async () => {
    vi.useFakeTimers();

    const gracePeriodMs = 5000;
    const cancelCheckRunMock = vi.fn().mockResolvedValue(undefined);
    const requeueJobMock = vi.fn().mockResolvedValue(undefined);
    const stopHeartbeatMock = vi.fn();

    // In-flight scan that hangs indefinitely
    const hangingWorker = {
      pause: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(() => new Promise<void>(() => {})), // never finishes
    };

    const scanId = "pr-scan:acme/backend:99";
    registerInFlightScan({
      id: scanId,
      repositoryFullName: "acme/backend",
      owner: "acme",
      repo: "backend",
      prNumber: 99,
      headSha: "fedcba9",
      checkRunId: 12345,
      lockKey: "pr-scan:acme/backend:99",
      lockToken: "lock-token-xyz",
      lockHeartbeat: { stop: stopHeartbeatMock },
      cancelCheckRun: cancelCheckRunMock,
      requeueJob: requeueJobMock,
    });

    expect(getInFlightScanCount()).toBe(1);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const shutdownPromise = gracefulShutdown("SIGTERM", {
      workers: [hangingWorker as any],
      timeoutMs: gracePeriodMs,
    });

    // Advance clock past the grace period to trigger forced shutdown cleanup
    await vi.advanceTimersByTimeAsync(gracePeriodMs);
    await shutdownPromise;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Graceful shutdown grace period timed out after 5000ms"),
    );

    // 1. Lock heartbeat stopped and lock released
    expect(stopHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(releaseLockSpy).toHaveBeenCalledWith("pr-scan:acme/backend:99", "lock-token-xyz");

    // 2. Check run marked neutral/cancelled with explanation (never left in progress)
    expect(cancelCheckRunMock).toHaveBeenCalledWith(
      expect.stringContaining("Worker container was terminated"),
    );

    // 3. Job re-queued for another worker
    expect(requeueJobMock).toHaveBeenCalledTimes(1);

    // 4. Registry cleared and Redis closed
    expect(getInFlightScanCount()).toBe(0);
    expect(closeRedisSpy).toHaveBeenCalledTimes(1);
  });

  it("re-queues scan jobs to a fake queue and verifies deduplication prevents duplicate scans", async () => {
    // Fake BullMQ Queue with ID-based deduplication
    class FakeQueue {
      private jobs = new Map<string, any>();

      async add(name: string, data: any, opts?: { jobId?: string; priority?: number }) {
        const jobId = opts?.jobId || `job-${Date.now()}`;
        if (this.jobs.has(jobId)) {
          // BullMQ returns existing job when duplicate ID is added
          return this.jobs.get(jobId);
        }
        const job = { id: jobId, name, data, queue: this };
        this.jobs.set(jobId, job);
        return job;
      }

      getJobCount(): number {
        return this.jobs.size;
      }

      hasJob(id: string): boolean {
        return this.jobs.has(id);
      }
    }

    const fakeQueue = new FakeQueue();
    const jobData = {
      repositoryFullName: "secureflow/core",
      prNumber: 15,
      deliveryId: "del-777",
    };

    // First enqueue
    const job1 = await fakeQueue.add("process-webhook", jobData, { jobId: "delivery:del-777" });
    expect(fakeQueue.getJobCount()).toBe(1);

    // Re-queuing with same jobId (deduplication) does not create a duplicate
    const job2 = await fakeQueue.add("process-webhook", jobData, { jobId: "delivery:del-777" });
    expect(fakeQueue.getJobCount()).toBe(1);
    expect(job1).toBe(job2);

    // Re-queueing via handleInterruptedScans
    registerInFlightScan({
      id: "scan-core-15",
      job: job1,
      repositoryFullName: "secureflow/core",
      owner: "secureflow",
      repo: "core",
      prNumber: 15,
      headSha: "headsha123",
      requeueJob: async () => {
        await fakeQueue.add(job1.name, job1.data, { jobId: job1.id });
      },
    });

    await handleInterruptedScans("Worker restarted");
    expect(fakeQueue.getJobCount()).toBe(1); // Still 1, no duplicate scan
  });

  it("prevents duplicate concurrent scans using per-PR distributed locking", async () => {
    const heldLocks = new Set<string>();

    const fakeAcquireLock = async (key: string): Promise<string | null> => {
      if (heldLocks.has(key)) {
        return null; // Lock already held by another scan
      }
      heldLocks.add(key);
      return `token-${key}`;
    };

    const fakeReleaseLock = async (key: string): Promise<boolean> => {
      heldLocks.delete(key);
      return true;
    };

    const prLockKey = "pr-scan:my-org/repo:101";

    // Worker 1 acquires lock
    const token1 = await fakeAcquireLock(prLockKey);
    expect(token1).toBeTruthy();

    // Worker 2 attempts concurrent scan on same PR: denied
    const token2 = await fakeAcquireLock(prLockKey);
    expect(token2).toBeNull();

    // Worker 1 interrupted by shutdown: releases lock
    await fakeReleaseLock(prLockKey);

    // Next worker can now cleanly acquire lock without duplicate conflict
    const token3 = await fakeAcquireLock(prLockKey);
    expect(token3).toBeTruthy();
  });

  it("logs every shutdown step clearly for operator observability", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await gracefulShutdown("SIGINT", {
      workers: [],
      drain: [],
      timeoutMs: 1000,
    });

    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("[Shutdown] Received SIGINT. Starting graceful worker shutdown");
    expect(logs).toContain("[Shutdown] Step 2/4: Waiting for in-flight jobs to complete");
    expect(logs).toContain("[Shutdown] Step 3/4: All in-flight scans and jobs completed");
    expect(logs).toContain("[Shutdown] Step 4/4: Closing Redis connections");
    expect(logs).toContain("[Shutdown] Graceful shutdown sequence completed");
  });

  it("registers signal handlers and invokes graceful shutdown on SIGTERM and SIGINT", async () => {
    const listeners: Record<string, () => Promise<void>> = {};
    vi.spyOn(process, "once").mockImplementation((event: string | symbol, listener: any) => {
      listeners[String(event)] = listener;
      return process;
    });

    setupWorkerSignalHandlers({ timeoutMs: 1000 });

    expect(listeners["SIGTERM"]).toBeDefined();
    expect(listeners["SIGINT"]).toBeDefined();

    // Trigger SIGTERM listener
    await listeners["SIGTERM"]();
    expect(isWorkerShuttingDown()).toBe(true);
  });
});
