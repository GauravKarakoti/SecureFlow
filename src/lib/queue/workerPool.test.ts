import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bull = vi.hoisted(() => ({
  instances: [] as Array<{
    name: string;
    processor: (job: unknown) => Promise<unknown>;
    opts: Record<string, unknown>;
    handlers: Record<string, (...args: any[]) => unknown>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("bullmq", () => {
  class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  }
  const Worker = vi.fn(function (
    this: any,
    name: string,
    processor: (job: unknown) => Promise<unknown>,
    opts: Record<string, unknown>,
  ) {
    // Mirrors BullMQ 6's own guard, which is what a NaN concurrency hits.
    const concurrency = opts.concurrency as number;
    if (typeof concurrency !== "number" || concurrency < 1 || !isFinite(concurrency)) {
      throw new Error("concurrency must be a finite number greater than 0");
    }
    const instance = { name, processor, opts, handlers: {}, close: vi.fn(async () => {}) };
    bull.instances.push(instance);
    this.on = (event: string, handler: (...args: any[]) => unknown) => {
      (instance.handlers as Record<string, unknown>)[event] = handler;
    };
    this.close = instance.close;
  });
  return { Worker, UnrecoverableError };
});

vi.mock("./redis", () => ({ redis: {} }));

const mockUpdateProgress = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./scanQueue", () => ({
  scanDLQ: { add: vi.fn() },
  updateScanJobProgress: mockUpdateProgress,
}));

const mockProcessScanJob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/scanner/scanEngine", () => ({ processScanJob: mockProcessScanJob }));

/** A fresh module per test: the pool is a module-level singleton. */
async function load() {
  vi.resetModules();
  return import("./workerPool");
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: { scanJobId: "scan-1", repositoryFullName: "org/api", prNumber: 7 },
    updateProgress: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  bull.instances.length = 0;
  mockUpdateProgress.mockClear();
  mockProcessScanJob.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("scanWorkerPool concurrency", () => {
  it.each(["", "   ", "three", "0"])(
    "does not read SCAN_WORKER_CONCURRENCY=%j itself, so it cannot reach BullMQ as NaN",
    async (value) => {
      vi.stubEnv("SCAN_WORKER_CONCURRENCY", value);
      const { scanWorkerPool } = await load();

      expect(() => scanWorkerPool.start()).not.toThrow();
      expect(bull.instances[0].opts.concurrency).toBe(3);
    },
  );

  it("uses the concurrency validated at startup", async () => {
    const { scanWorkerPool } = await load();

    scanWorkerPool.start(8);

    expect(bull.instances[0].name).toBe("vulnerability-scans");
    expect(bull.instances[0].opts).toMatchObject({ concurrency: 8, stalledInterval: 60_000 });
    expect(scanWorkerPool.getConcurrency()).toBe(8);
  });

  it("starts once, and stop() closes the worker", async () => {
    const { startScanWorker, stopScanWorker, scanWorkerPool } = await load();

    startScanWorker(2);
    startScanWorker(4);
    expect(bull.instances).toHaveLength(1);
    expect(scanWorkerPool.isRunning()).toBe(true);

    await stopScanWorker();
    expect(bull.instances[0].close).toHaveBeenCalledOnce();
    expect(scanWorkerPool.isRunning()).toBe(false);

    await stopScanWorker(); // no-op once stopped
    expect(bull.instances[0].close).toHaveBeenCalledOnce();
  });
});

describe("scan job processing", () => {
  async function startedProcessor() {
    const { scanWorkerPool } = await load();
    scanWorkerPool.start();
    return bull.instances[0].processor;
  }

  it("marks the job processing, then completed with the mapped verdict", async () => {
    mockProcessScanJob.mockImplementation(async (_data, onProgress) => {
      onProgress({ phase: "scanning", scannedFiles: 1 });
      return {
        scannedFiles: 3,
        vulnerabilitiesFound: 1,
        riskScore: 40,
        policyDecision: "REVIEW REQUIRED",
      };
    });
    const process = await startedProcessor();
    const j = job();

    await expect(process(j)).resolves.toEqual({ scanJobId: "scan-1" });

    expect(mockUpdateProgress).toHaveBeenNthCalledWith(
      1,
      "scan-1",
      expect.objectContaining({ status: "PROCESSING" }),
    );
    expect(mockUpdateProgress).toHaveBeenNthCalledWith(
      2,
      "scan-1",
      expect.objectContaining({ status: "COMPLETED" }),
    );
    expect(j.updateProgress).toHaveBeenCalledWith({ phase: "scanning", scannedFiles: 1 });
  });

  it("marks the job failed and rethrows an ordinary error for a retry", async () => {
    mockProcessScanJob.mockRejectedValue(new Error("Groq timed out"));
    const process = await startedProcessor();

    await expect(process(job())).rejects.toThrow("Groq timed out");

    expect(mockUpdateProgress).toHaveBeenLastCalledWith(
      "scan-1",
      expect.objectContaining({ status: "FAILED", error: "Groq timed out" }),
    );
  });

  it("does not retry a persistence failure or a bad installation id", async () => {
    const process = await startedProcessor();
    // Imported after `load()` reset the registry, so these are the classes the pool sees.
    const { ScanPersistenceError, InvalidInstallationIdError } =
      await import("@/lib/scanner/scan-persistence");

    for (const err of [new ScanPersistenceError("FK"), new InvalidInstallationIdError("x")]) {
      mockProcessScanJob.mockRejectedValueOnce(err);
      await expect(process(job())).rejects.toMatchObject({ name: "UnrecoverableError" });
    }
  });

  it("records a non-Error rejection as an unknown error", async () => {
    mockProcessScanJob.mockRejectedValue("boom");
    const process = await startedProcessor();

    await expect(process(job())).rejects.toBe("boom");
    expect(mockUpdateProgress).toHaveBeenLastCalledWith(
      "scan-1",
      expect.objectContaining({ error: "Unknown error" }),
    );
  });
});
