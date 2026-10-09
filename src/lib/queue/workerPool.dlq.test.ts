import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({}) as Record<string, (...args: any[]) => unknown>);

vi.mock("bullmq", () => ({
  Worker: vi.fn(function (this: any) {
    this.on = (event: string, handler: (...args: any[]) => unknown) => {
      handlers[event] = handler;
    };
  }),
  UnrecoverableError: class UnrecoverableError extends Error {
    name = "UnrecoverableError";
  },
}));

vi.mock("./redis", () => ({ redis: {} }));

const mockDlqAdd = vi.hoisted(() => vi.fn());
vi.mock("./scanQueue", () => ({
  scanDLQ: { add: mockDlqAdd },
  updateScanJobProgress: vi.fn(),
}));
vi.mock("@/lib/scanner/scanEngine", () => ({ processScanJob: vi.fn() }));

import { isFinalFailure, scanWorkerPool } from "./workerPool";

function failedJob(attemptsMade: number, attempts: number | undefined = 2) {
  return {
    id: "scan-job-9",
    attemptsMade,
    opts: { attempts },
    data: { scanJobId: "scan-9", repositoryFullName: "org/api", prNumber: 3 },
  };
}

function unrecoverable(message: string) {
  const err = new Error(message);
  err.name = "UnrecoverableError";
  return err;
}

describe("isFinalFailure", () => {
  it("is final once the attempts are used up", () => {
    expect(isFinalFailure(failedJob(2), new Error("x"))).toBe(true);
    expect(isFinalFailure(failedJob(1), new Error("x"))).toBe(false);
  });

  it("defaults to two attempts, matching the scan queue", () => {
    expect(isFinalFailure(failedJob(2, undefined), new Error("x"))).toBe(true);
    expect(isFinalFailure(failedJob(1, undefined), new Error("x"))).toBe(false);
  });

  it("is final on the first attempt for an UnrecoverableError", () => {
    expect(isFinalFailure(failedJob(1), unrecoverable("bad installation id"))).toBe(true);
  });
});

describe("scan worker `failed` handler", () => {
  beforeEach(() => {
    mockDlqAdd.mockReset().mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    if (!scanWorkerPool.isRunning()) scanWorkerPool.start();
  });

  it("records an unrecoverable first-attempt failure in the DLQ", async () => {
    const err = unrecoverable("Scan completed but its results could not be persisted: FK");

    await handlers.failed(failedJob(1), err);

    expect(mockDlqAdd).toHaveBeenCalledWith(
      "failed-scan",
      expect.objectContaining({ scanJobId: "scan-9", error: err.message }),
    );
  });

  it("leaves a retryable first-attempt failure to BullMQ's retry", async () => {
    await handlers.failed(failedJob(1), new Error("Groq timed out"));

    expect(mockDlqAdd).not.toHaveBeenCalled();
  });

  it("records a failure that used up its attempts", async () => {
    await handlers.failed(failedJob(2), new Error("Groq timed out"));

    expect(mockDlqAdd).toHaveBeenCalledOnce();
  });

  it("survives a DLQ write failure", async () => {
    mockDlqAdd.mockRejectedValue(new Error("Redis down"));

    await expect(handlers.failed(failedJob(2), new Error("x"))).resolves.toBeUndefined();
  });

  it("ignores a failure event without a job", async () => {
    await handlers.failed(undefined, new Error("x"));

    expect(mockDlqAdd).not.toHaveBeenCalled();
  });
});
