import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./redis", () => ({ redis: { set: vi.fn() } }));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (this: any) {
    this.on = vi.fn();
  }),
  Queue: vi.fn().mockImplementation(function (this: any) {
    this.add = vi.fn();
  }),
  DelayedError: class DelayedError extends Error {},
}));

import {
  FairQueueScheduler,
  DEFAULT_INSTALLATION_CONCURRENCY_LIMIT,
  resolveInstallationConcurrencyLimit,
  type Clock,
  type FairJob,
} from "./fair-scheduler";

class FakeClock implements Clock {
  private currentTime = 1_000_000;
  private timers = new Map<number, { fn: () => void; due: number }>();
  private nextTimerId = 1;

  now(): number {
    return this.currentTime;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextTimerId++;
    this.timers.set(id, { fn, due: this.currentTime + ms });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    this.currentTime += ms;
    const runnable = Array.from(this.timers.entries())
      .filter(([_, t]) => t.due <= this.currentTime)
      .sort((a, b) => a[1].due - b[1].due);

    for (const [id, timer] of runnable) {
      this.timers.delete(id);
      timer.fn();
    }
  }

  hasPendingTimers(): boolean {
    return this.timers.size > 0;
  }
}

/**
 * Fake queue representing incoming webhook deliveries or scan requests.
 */
class FakeQueue {
  private jobs: FairJob[] = [];

  push(job: FairJob): void {
    this.jobs.push(job);
  }

  drainInto(scheduler: FairQueueScheduler): void {
    while (this.jobs.length > 0) {
      scheduler.enqueue(this.jobs.shift()!);
    }
  }

  get length(): number {
    return this.jobs.length;
  }
}

describe("FairQueueScheduler (#1980)", () => {
  let clock: FakeClock;
  let fakeQueue: FakeQueue;

  beforeEach(() => {
    clock = new FakeClock();
    fakeQueue = new FakeQueue();
  });

  describe("Configuration and Environment Resolution", () => {
    it("defaults to 2 when no environment variable is set", () => {
      expect(resolveInstallationConcurrencyLimit({})).toBe(2);
      expect(DEFAULT_INSTALLATION_CONCURRENCY_LIMIT).toBe(2);
    });

    it("reads SCAN_INSTALLATION_CONCURRENCY_LIMIT when present", () => {
      expect(
        resolveInstallationConcurrencyLimit({ SCAN_INSTALLATION_CONCURRENCY_LIMIT: "4" }),
      ).toBe(4);
    });

    it("falls back to INSTALLATION_CONCURRENCY_LIMIT", () => {
      expect(resolveInstallationConcurrencyLimit({ INSTALLATION_CONCURRENCY_LIMIT: "5" })).toBe(5);
    });

    it("prefers SCAN_INSTALLATION_CONCURRENCY_LIMIT over INSTALLATION_CONCURRENCY_LIMIT", () => {
      expect(
        resolveInstallationConcurrencyLimit({
          SCAN_INSTALLATION_CONCURRENCY_LIMIT: "6",
          INSTALLATION_CONCURRENCY_LIMIT: "3",
        }),
      ).toBe(6);
    });

    it.each(["", "invalid", "0", "-1", "NaN"])(
      "falls back to default (2) for invalid input: %j",
      (val) => {
        expect(
          resolveInstallationConcurrencyLimit({ SCAN_INSTALLATION_CONCURRENCY_LIMIT: val }),
        ).toBe(2);
      },
    );
  });

  describe("Starvation Prevention & Bounded Wait", () => {
    it("ensures another installation starts within a bounded wait when one installation floods the queue", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        totalConcurrencyLimit: 10,
        clock,
      });

      // Installation 1 floods the queue with 20 PRs
      for (let pr = 1; pr <= 20; pr++) {
        fakeQueue.push({
          id: `job-inst1-pr${pr}`,
          installationId: "inst-1",
          repositoryFullName: "heavy-org/monorepo",
          prNumber: pr,
        });
      }
      fakeQueue.drainInto(scheduler);

      // Inst 1 should have exactly 2 active jobs (its concurrency limit)
      expect(scheduler.getActivePerInstallation()["inst-1"]).toBe(2);
      expect(scheduler.getQueueDepthPerInstallation()["inst-1"]).toBe(18);

      // Now Installation 2 opens a single small PR
      const inst2Job: FairJob = {
        id: "job-inst2-pr100",
        installationId: "inst-2",
        repositoryFullName: "small-org/service",
        prNumber: 100,
      };
      scheduler.enqueue(inst2Job);

      // Inst 2 should NOT wait behind the 18 waiting jobs of Inst 1!
      // It starts immediately on the round-robin dispatch.
      expect(scheduler.getActivePerInstallation()["inst-2"]).toBe(1);
      expect(scheduler.getActiveJob("job-inst2-pr100")?.status).toBe("active");
      expect(scheduler.getQueueDepthPerInstallation()["inst-2"]).toBeUndefined();

      // Inst 1 still has 2 active and 18 waiting
      expect(scheduler.getActivePerInstallation()["inst-1"]).toBe(2);
      expect(scheduler.getQueueDepthPerInstallation()["inst-1"]).toBe(18);
    });

    it("round-robin rotates dispatch fairly across multiple installations", () => {
      const executionOrder: string[] = [];
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 1,
        totalConcurrencyLimit: 1, // 1 slot total to test strict sequential round-robin
        clock,
      });

      // Enqueue 2 jobs each for 3 installations
      scheduler.enqueue({
        id: "j-A1",
        installationId: "inst-A",
        repositoryFullName: "org/a",
        prNumber: 1,
      });
      scheduler.enqueue({
        id: "j-A2",
        installationId: "inst-A",
        repositoryFullName: "org/a",
        prNumber: 2,
      });
      scheduler.enqueue({
        id: "j-B1",
        installationId: "inst-B",
        repositoryFullName: "org/b",
        prNumber: 1,
      });
      scheduler.enqueue({
        id: "j-B2",
        installationId: "inst-B",
        repositoryFullName: "org/b",
        prNumber: 2,
      });
      scheduler.enqueue({
        id: "j-C1",
        installationId: "inst-C",
        repositoryFullName: "org/c",
        prNumber: 1,
      });
      scheduler.enqueue({
        id: "j-C2",
        installationId: "inst-C",
        repositoryFullName: "org/c",
        prNumber: 2,
      });

      // First job dispatched
      expect(scheduler.getTotalActive()).toBe(1);
      const firstActive = scheduler.getActiveJob("j-A1");
      expect(firstActive?.status).toBe("active");
      executionOrder.push(firstActive!.id);

      // Complete j-A1 -> next round-robin should pick inst-B, not inst-A!
      scheduler.completeJob("j-A1");
      expect(scheduler.getActiveJob("j-B1")?.status).toBe("active");
      executionOrder.push("j-B1");

      // Complete j-B1 -> next should pick inst-C!
      scheduler.completeJob("j-B1");
      expect(scheduler.getActiveJob("j-C1")?.status).toBe("active");
      executionOrder.push("j-C1");

      // Complete j-C1 -> next round-robin returns to inst-A!
      scheduler.completeJob("j-C1");
      expect(scheduler.getActiveJob("j-A2")?.status).toBe("active");
      executionOrder.push("j-A2");

      // Complete j-A2 -> next inst-B
      scheduler.completeJob("j-A2");
      expect(scheduler.getActiveJob("j-B2")?.status).toBe("active");
      executionOrder.push("j-B2");

      // Complete j-B2 -> next inst-C
      scheduler.completeJob("j-B2");
      expect(scheduler.getActiveJob("j-C2")?.status).toBe("active");
      executionOrder.push("j-C2");

      expect(executionOrder).toEqual(["j-A1", "j-B1", "j-C1", "j-A2", "j-B2", "j-C2"]);
    });
  });

  describe("Per-Installation Concurrency Limits", () => {
    it("strictly caps active jobs at the configured limit", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        clock,
      });

      for (let i = 1; i <= 5; i++) {
        scheduler.enqueue({
          id: `job-${i}`,
          installationId: "inst-corp",
          repositoryFullName: "corp/repo",
          prNumber: i,
        });
      }

      // Exactly 2 jobs running
      expect(scheduler.getTotalActive()).toBe(2);
      expect(scheduler.getActivePerInstallation()["inst-corp"]).toBe(2);
      expect(scheduler.getQueueDepthPerInstallation()["inst-corp"]).toBe(3);

      // Completing 1 job starts the 3rd job
      scheduler.completeJob("job-1");
      expect(scheduler.getTotalActive()).toBe(2);
      expect(scheduler.getActiveJob("job-3")?.status).toBe("active");
      expect(scheduler.getQueueDepthPerInstallation()["inst-corp"]).toBe(2);

      // Completing the 2nd job starts the 4th job
      scheduler.completeJob("job-2");
      expect(scheduler.getTotalActive()).toBe(2);
      expect(scheduler.getActiveJob("job-4")?.status).toBe("active");
      expect(scheduler.getQueueDepthPerInstallation()["inst-corp"]).toBe(1);
    });

    it("allows updating the limit dynamically", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        clock,
      });

      for (let i = 1; i <= 5; i++) {
        scheduler.enqueue({
          id: `job-${i}`,
          installationId: "inst-corp",
          repositoryFullName: "corp/repo",
          prNumber: i,
        });
      }
      expect(scheduler.getTotalActive()).toBe(2);

      // Increase limit to 4
      scheduler.setInstallationConcurrencyLimit(4);
      expect(scheduler.getInstallationConcurrencyLimit()).toBe(4);
      expect(scheduler.getTotalActive()).toBe(4);
      expect(scheduler.getQueueDepthPerInstallation()["inst-corp"]).toBe(1);
    });
  });

  describe("Per-PR Locking & In-Order Execution", () => {
    it("never runs jobs for the same PR in parallel and strictly preserves order", () => {
      const executedOrder: string[] = [];
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 3, // capacity available for 3
        clock,
      });

      // 3 jobs for the SAME PR #42
      scheduler.enqueue({
        id: "commit-1",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 42,
      });
      scheduler.enqueue({
        id: "commit-2",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 42,
      });
      scheduler.enqueue({
        id: "commit-3",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 42,
      });

      // Even though limit is 3, only 1 job for PR #42 can run!
      expect(scheduler.getTotalActive()).toBe(1);
      expect(scheduler.getActiveJob("commit-1")?.status).toBe("active");
      expect(scheduler.getActiveJob("commit-2")).toBeUndefined();
      expect(scheduler.getActiveJob("commit-3")).toBeUndefined();
      executedOrder.push("commit-1");

      // Commit 1 finishes
      scheduler.completeJob("commit-1");
      expect(scheduler.getActiveJob("commit-2")?.status).toBe("active");
      expect(scheduler.getActiveJob("commit-3")).toBeUndefined();
      executedOrder.push("commit-2");

      // Commit 2 finishes
      scheduler.completeJob("commit-2");
      expect(scheduler.getActiveJob("commit-3")?.status).toBe("active");
      executedOrder.push("commit-3");

      scheduler.completeJob("commit-3");
      expect(scheduler.getTotalActive()).toBe(0);
      expect(executedOrder).toEqual(["commit-1", "commit-2", "commit-3"]);
    });

    it("allows a different PR from the same installation to run while another PR is active", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        clock,
      });

      // Job A (PR 1), Job B (PR 2), Job C (PR 1)
      scheduler.enqueue({
        id: "job-A",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 1,
      });
      scheduler.enqueue({
        id: "job-B",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 2,
      });
      scheduler.enqueue({
        id: "job-C",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 1,
      });

      // Job A (PR 1) and Job B (PR 2) should run concurrently
      expect(scheduler.getActiveJob("job-A")?.status).toBe("active");
      expect(scheduler.getActiveJob("job-B")?.status).toBe("active");
      expect(scheduler.getTotalActive()).toBe(2);

      // Job C must wait because PR 1 is active (and limit of 2 is full)
      expect(scheduler.getQueueDepthPerInstallation()["inst-1"]).toBe(1);

      // When Job A finishes, Job C can run
      scheduler.completeJob("job-A");
      expect(scheduler.getActiveJob("job-C")?.status).toBe("active");
      expect(scheduler.getTotalActive()).toBe(2);
    });
  });

  describe("Deduplication", () => {
    it("deduplicates identical job IDs when already waiting or active", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        clock,
      });

      const job: FairJob = {
        id: "delivery-12345",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 10,
      };

      expect(scheduler.enqueue(job)).toBe(true);
      // Enqueueing same job ID again should be rejected (deduped)
      expect(scheduler.enqueue(job)).toBe(false);
      expect(scheduler.getTotalActive()).toBe(1);
    });
  });

  describe("Dead Letter Queue (DLQ) and Retries", () => {
    it("retries failed jobs with backoff while preserving PR head-of-line ordering", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        retryDelayMs: 2000,
        clock,
      });

      scheduler.enqueue({
        id: "retry-job",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 5,
        maxAttempts: 3,
      });

      expect(scheduler.getActiveJob("retry-job")?.status).toBe("active");

      // Job fails on first attempt
      scheduler.failJob("retry-job", new Error("Network blip"));

      // Active slot is freed immediately!
      expect(scheduler.getTotalActive()).toBe(0);
      expect(clock.hasPendingTimers()).toBe(true);

      // Advance clock past retry backoff
      clock.advance(2000);

      // Job is re-dispatched for attempt 2
      const retried = scheduler.getActiveJob("retry-job");
      expect(retried?.status).toBe("active");
      expect(retried?.attemptsMade).toBe(1);
    });

    it("routes exhausted jobs to DLQ and frees capacity for waiting jobs", () => {
      const deadLetterSink: FairJob[] = [];
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 1,
        clock,
        onDeadLetter: (job) => {
          deadLetterSink.push(job);
        },
      });

      scheduler.enqueue({
        id: "flaky-job",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 7,
        maxAttempts: 2,
      });

      scheduler.enqueue({
        id: "waiting-job",
        installationId: "inst-1",
        repositoryFullName: "org/repo",
        prNumber: 8,
      });

      // Attempt 1 fails
      scheduler.failJob("flaky-job", new Error("Error 1"));
      clock.advance(1000);

      // Attempt 2 fails (exhausted)
      scheduler.failJob("flaky-job", new Error("Permanent Error"));

      // Flaky job is in DLQ
      expect(deadLetterSink).toHaveLength(1);
      expect(deadLetterSink[0].id).toBe("flaky-job");
      expect(deadLetterSink[0].status).toBe("dead_letter");
      expect(scheduler.getDeadLetterJobs()).toHaveLength(1);

      // Waiting job now takes the freed slot!
      expect(scheduler.getActiveJob("waiting-job")?.status).toBe("active");
    });
  });

  describe("Queue Depth & Telemetry", () => {
    it("reports accurate per-installation queue depth and active counts", () => {
      const scheduler = new FairQueueScheduler({
        concurrencyLimit: 2,
        clock,
      });

      scheduler.enqueue({
        id: "1",
        installationId: "inst-A",
        repositoryFullName: "a/repo",
        prNumber: 1,
      });
      scheduler.enqueue({
        id: "2",
        installationId: "inst-A",
        repositoryFullName: "a/repo",
        prNumber: 2,
      });
      scheduler.enqueue({
        id: "3",
        installationId: "inst-A",
        repositoryFullName: "a/repo",
        prNumber: 3,
      });

      scheduler.enqueue({
        id: "4",
        installationId: "inst-B",
        repositoryFullName: "b/repo",
        prNumber: 1,
      });

      const depths = scheduler.getQueueDepthPerInstallation();
      const actives = scheduler.getActivePerInstallation();

      expect(depths).toEqual({ "inst-A": 1 }); // 2 active, 1 waiting
      expect(actives).toEqual({ "inst-A": 2, "inst-B": 1 });
      expect(scheduler.getTotalWaiting()).toBe(1);
      expect(scheduler.getTotalActive()).toBe(3);
    });
  });

  describe("Worker Pull Request Concurrency Guard", () => {
    it("delays the job when installation reaches concurrency limit", async () => {
      const { runPullRequestScan, INSTALLATION_CONCURRENCY_RETRY_DELAY_MS } =
        await import("./worker");
      const { registerInFlightScan, clearInFlightScans } = await import("./in-flight-scans");
      clearInFlightScans();

      // Register 2 active in-flight scans for installation 9999 (default limit 2)
      registerInFlightScan({
        id: "active-1",
        repositoryFullName: "org/repo",
        owner: "org",
        repo: "repo",
        prNumber: 1,
        installationId: 9999,
      });
      registerInFlightScan({
        id: "active-2",
        repositoryFullName: "org/repo",
        owner: "org",
        repo: "repo",
        prNumber: 2,
        installationId: 9999,
      });

      const mockJob = {
        id: "job-3",
        token: "job-token",
        moveToDelayed: vi.fn().mockResolvedValue(undefined),
      };

      const mockLog = {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      };

      await expect(
        runPullRequestScan({
          job: mockJob as any,
          payload: {},
          pullRequest: { number: 3, head: { sha: "abc" } },
          repository: { full_name: "org/repo", name: "repo", owner: { login: "org" } },
          installation: { id: 9999 },
          event: "pull_request",
          action: "opened",
          deliveryId: "del-3",
          correlationId: "corr-3",
          log: mockLog,
        }),
      ).rejects.toThrow();

      expect(mockJob.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "job-token");
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("Installation 9999 reached concurrency limit"),
      );

      clearInFlightScans();
    });
  });
});
