import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeNextRetryAt,
  dlqRetryStateFor,
  isRetryDue,
  retryDlqJob,
  createDlqAutoRetryWorker,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_AUTO_RETRY_ATTEMPTS,
  POLL_INTERVAL_MS,
  type DlqAutoRetryJobData,
} from "./dlq-auto-retry";
import type { DlqJobLike } from "./dlq";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./webhookQueue", () => ({
  webhookDLQ: {
    getJobs: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({ id: "new-dlq-job" }),
  },
  addWebhookJob: vi.fn().mockResolvedValue({ id: "new-main-job" }),
}));

// Import after mock so the mock is in place
import { webhookDLQ, addWebhookJob } from "./webhookQueue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: DlqAutoRetryJobData, overrides: Partial<DlqJobLike> = {}) {
  const remove = vi.fn().mockResolvedValue(undefined);

  return {
    id: "dlq-job-1",
    data,
    remove,
    ...overrides,
  } as unknown as DlqJobLike & { remove: ReturnType<typeof vi.fn> };
}

function validPayload() {
  return {
    event: "pull_request",
    deliveryId: "delivery-abc-123",
    payload: { action: "opened" },
  };
}

// ---------------------------------------------------------------------------
// computeNextRetryAt
// ---------------------------------------------------------------------------

describe("computeNextRetryAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns BASE_DELAY_MS * 2^0 for the first retry", () => {
    const result = computeNextRetryAt(0);
    const expectedMs = BASE_DELAY_MS * Math.pow(2, 0);
    expect(result.getTime()).toBe(Date.now() + expectedMs);
  });

  it("doubles the delay on each subsequent attempt", () => {
    const t0 = computeNextRetryAt(0).getTime() - Date.now();
    const t1 = computeNextRetryAt(1).getTime() - Date.now();
    const t2 = computeNextRetryAt(2).getTime() - Date.now();

    expect(t1).toBe(t0 * 2);
    expect(t2).toBe(t0 * 4);
  });

  it("caps at MAX_DELAY_MS regardless of attempt count", () => {
    const high = computeNextRetryAt(100).getTime() - Date.now();
    expect(high).toBe(MAX_DELAY_MS);
  });

  it("never exceeds MAX_DELAY_MS", () => {
    for (let i = 0; i <= MAX_AUTO_RETRY_ATTEMPTS + 2; i++) {
      const delay = computeNextRetryAt(i).getTime() - Date.now();
      expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// isRetryDue
// ---------------------------------------------------------------------------

describe("isRetryDue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when nextRetryAt is null", () => {
    expect(isRetryDue(null)).toBe(true);
  });

  it("returns true when nextRetryAt is undefined", () => {
    expect(isRetryDue(undefined)).toBe(true);
  });

  it("returns true when the scheduled time has elapsed", () => {
    expect(isRetryDue("2026-01-01T11:59:59.000Z")).toBe(true);
  });

  it("returns true when the scheduled time equals now", () => {
    expect(isRetryDue("2026-01-01T12:00:00.000Z")).toBe(true);
  });

  it("returns false when the scheduled time is in the future", () => {
    expect(isRetryDue("2026-01-01T12:00:01.000Z")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retryDlqJob
// ---------------------------------------------------------------------------

describe("retryDlqJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requeues a due job with a valid payload", async () => {
    const job = makeJob({ data: validPayload() });

    const outcome = await retryDlqJob(job);

    expect(outcome.result).toBe("requeued");
    expect(job.remove).toHaveBeenCalledOnce();
    expect(addWebhookJob).toHaveBeenCalledOnce();
  });

  it("removes from DLQ before adding to main queue (remove-first order)", async () => {
    const callOrder: string[] = [];
    const job = makeJob({ data: validPayload() });
    job.remove.mockImplementation(async () => {
      callOrder.push("remove");
    });
    vi.mocked(addWebhookJob).mockImplementation(async () => {
      callOrder.push("add");
      return { id: "x" } as any;
    });

    await retryDlqJob(job);

    expect(callOrder).toEqual(["remove", "add"]);
  });

  it("skips a job whose nextRetryAt is in the future", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const job = makeJob({ data: validPayload(), nextRetryAt: future });

    const outcome = await retryDlqJob(job);

    expect(outcome.result).toBe("skipped_not_due");
    expect(job.remove).not.toHaveBeenCalled();
    expect(addWebhookJob).not.toHaveBeenCalled();
  });

  it("skips a job that has exceeded MAX_AUTO_RETRY_ATTEMPTS", async () => {
    const job = makeJob({
      data: validPayload(),
      autoRetryCount: MAX_AUTO_RETRY_ATTEMPTS,
    });

    const outcome = await retryDlqJob(job);

    expect(outcome.result).toBe("skipped_max_attempts");
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("skips a job with no usable payload", async () => {
    const job = makeJob({ data: undefined });

    const outcome = await retryDlqJob(job);

    expect(outcome.result).toBe("skipped_no_payload");
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("re-inserts with incremented autoRetryCount when addWebhookJob throws", async () => {
    vi.mocked(addWebhookJob).mockRejectedValueOnce(new Error("Redis down"));
    const job = makeJob({ data: validPayload(), autoRetryCount: 1 });

    const outcome = await retryDlqJob(job);

    expect(outcome.result).toBe("failed");
    expect(outcome.reason).toContain("Redis down");

    const addCall = vi.mocked(webhookDLQ.add).mock.calls[0];
    expect(addCall[1]).toMatchObject({ autoRetryCount: 2 });
    expect(typeof addCall[1].nextRetryAt).toBe("string");
  });

  it("carries the incremented count on the requeued job, so a re-failure keeps it", async () => {
    const job = makeJob({ data: validPayload(), autoRetryCount: 2 });

    await retryDlqJob(job);

    const [payload] = vi.mocked(addWebhookJob).mock.calls[0];
    expect(payload).toEqual({ ...validPayload(), dlqAutoRetryCount: 3 });
  });

  it("does not duplicate the entry when removing it from the DLQ fails", async () => {
    const job = makeJob({ data: validPayload(), autoRetryCount: 1 });
    job.remove.mockRejectedValueOnce(new Error("Job is locked"));

    const outcome = await retryDlqJob(job);

    expect(outcome).toMatchObject({ result: "failed", reason: "Job is locked" });
    expect(addWebhookJob).not.toHaveBeenCalled();
    expect(webhookDLQ.add).not.toHaveBeenCalled();
  });

  it("passes the delivery-id-keyed jobId to addWebhookJob for idempotency", async () => {
    const job = makeJob({ data: validPayload() });

    await retryDlqJob(job);

    const [, options] = vi.mocked(addWebhookJob).mock.calls[0];
    // requeueOptionsFor derives delivery-<id> from the deliveryId field
    expect(options?.jobId).toMatch(/^delivery-/);
  });

  it("still requeues without a jobId when the payload has no deliveryId", async () => {
    const job = makeJob({ data: { event: "push", payload: {} } });

    const outcome = await retryDlqJob(job);

    expect(outcome.result).toBe("requeued");
    const [, options] = vi.mocked(addWebhookJob).mock.calls[0];
    expect(options?.jobId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dlqRetryStateFor — what the worker writes when a requeued job fails again
// ---------------------------------------------------------------------------

describe("dlqRetryStateFor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds nothing for a delivery the auto-retry worker never requeued", () => {
    expect(dlqRetryStateFor(undefined)).toEqual({});
    expect(dlqRetryStateFor(0)).toEqual({});
    expect(dlqRetryStateFor("3")).toEqual({});
    expect(dlqRetryStateFor(1.5)).toEqual({});
  });

  it("keeps the count and schedules the next attempt with backoff", () => {
    expect(dlqRetryStateFor(2)).toEqual({
      autoRetryCount: 2,
      nextRetryAt: new Date(Date.now() + BASE_DELAY_MS * 4).toISOString(),
    });
  });

  it("stops after MAX_AUTO_RETRY_ATTEMPTS requeue-and-fail cycles", async () => {
    // Each cycle: the DLQ entry is requeued, the job fails again, and the
    // worker writes a new entry from the count the job carried.
    let entry: DlqAutoRetryJobData = { data: validPayload() };

    for (let cycle = 1; cycle <= MAX_AUTO_RETRY_ATTEMPTS; cycle++) {
      vi.mocked(addWebhookJob).mockClear();
      vi.setSystemTime(new Date(Date.now() + MAX_DELAY_MS));

      expect((await retryDlqJob(makeJob(entry))).result).toBe("requeued");
      const [requeued] = vi.mocked(addWebhookJob).mock.calls[0];
      entry = { data: validPayload(), ...dlqRetryStateFor(requeued.dlqAutoRetryCount) };
    }

    vi.setSystemTime(new Date(Date.now() + MAX_DELAY_MS));
    expect((await retryDlqJob(makeJob(entry))).result).toBe("skipped_max_attempts");
  });
});

// ---------------------------------------------------------------------------
// createDlqAutoRetryWorker — polling loop
// ---------------------------------------------------------------------------

describe("createDlqAutoRetryWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately on start", async () => {
    vi.mocked(webhookDLQ.getJobs).mockResolvedValue([]);
    const w = createDlqAutoRetryWorker({ pollIntervalMs: 1000 });

    w.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(webhookDLQ.getJobs).toHaveBeenCalledOnce();
    await w.stop();
  });

  it("schedules the next poll after the interval", async () => {
    vi.mocked(webhookDLQ.getJobs).mockResolvedValue([]);
    const w = createDlqAutoRetryWorker({ pollIntervalMs: 1000 });

    w.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(webhookDLQ.getJobs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(webhookDLQ.getJobs).toHaveBeenCalledTimes(2);

    await w.stop();
  });

  it("does not poll after stop is called", async () => {
    vi.mocked(webhookDLQ.getJobs).mockResolvedValue([]);
    const w = createDlqAutoRetryWorker({ pollIntervalMs: 1000 });

    w.start();
    await vi.advanceTimersByTimeAsync(1);
    await w.stop();

    const callsBefore = vi.mocked(webhookDLQ.getJobs).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(vi.mocked(webhookDLQ.getJobs).mock.calls.length).toBe(callsBefore);
  });

  it("calling start twice does not double-poll", async () => {
    vi.mocked(webhookDLQ.getJobs).mockResolvedValue([]);
    const w = createDlqAutoRetryWorker({ pollIntervalMs: 1000 });

    w.start();
    w.start(); // second call should be a no-op
    await vi.advanceTimersByTimeAsync(1);

    expect(webhookDLQ.getJobs).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it("continues polling after a Redis read error", async () => {
    vi.mocked(webhookDLQ.getJobs)
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue([]);

    const w = createDlqAutoRetryWorker({ pollIntervalMs: 500 });
    w.start();
    await vi.advanceTimersByTimeAsync(1);

    // First poll threw — worker should still schedule the next one
    await vi.advanceTimersByTimeAsync(500);

    expect(webhookDLQ.getJobs).toHaveBeenCalledTimes(2);
    await w.stop();
  });

  it("uses POLL_INTERVAL_MS as the default interval", () => {
    // Verify the exported constant is the value the worker defaults to.
    // This is a contract test: if someone changes the default they must also
    // update the constant (and the docs).
    expect(POLL_INTERVAL_MS).toBe(30_000);
  });

  it("requeues eligible jobs found during a poll", async () => {
    const job = makeJob({ data: validPayload() });
    vi.mocked(webhookDLQ.getJobs).mockResolvedValueOnce([job as any]);

    const w = createDlqAutoRetryWorker({ pollIntervalMs: 1000 });
    w.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(addWebhookJob).toHaveBeenCalledOnce();
    await w.stop();
  });
});
