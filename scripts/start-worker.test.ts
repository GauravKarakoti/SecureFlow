import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type { GracefulShutdownOptions } from "../src/lib/queue/shutdown";

// Mock worker instances and queue modules
vi.mock("../src/lib/queue/worker", () => ({
  worker: {
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/lib/queue/outboundWorker", () => ({
  outboundWorker: {
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/lib/queue/sbomWorker", () => ({
  sbomWorker: {
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/lib/queue/workerPool", () => ({
  scanWorkerPool: {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/lib/queue/dlq-auto-retry", () => ({
  createDlqAutoRetryWorker: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/lib/queue/remediationDlq", () => ({
  createRemediationDlqWorker: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/lib/queue/shutdown", () => ({
  setupWorkerSignalHandlers: vi.fn(),
}));

import { worker } from "../src/lib/queue/worker";
import { outboundWorker } from "../src/lib/queue/outboundWorker";
import { sbomWorker } from "../src/lib/queue/sbomWorker";
import { scanWorkerPool } from "../src/lib/queue/workerPool";
import { setupWorkerSignalHandlers } from "../src/lib/queue/shutdown";
import { createDlqAutoRetryWorker } from "../src/lib/queue/dlq-auto-retry";
import { createRemediationDlqWorker } from "../src/lib/queue/remediationDlq";
import { createWorkerApp, startWorkerServer } from "./start-worker";

describe("scripts/start-worker.ts (#1354)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Health Check Endpoint", () => {
    it("responds with 200 OK on GET /health", async () => {
      const app = createWorkerApp();
      const server = app.listen(0);
      try {
        const address = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${address.port}/health`);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toBe("OK");
      } finally {
        server.close();
      }
    });
  });

  describe("Worker Initialization", () => {
    it("attaches ready and error listeners to inbound, outbound, and sbom workers", () => {
      startWorkerServer({ autoListen: false, setupSignals: false });

      expect(worker.on).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(worker.on).toHaveBeenCalledWith("error", expect.any(Function));

      expect(outboundWorker.on).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(outboundWorker.on).toHaveBeenCalledWith("error", expect.any(Function));

      expect(sbomWorker.on).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(sbomWorker.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("initializes and starts the DLQ auto-retry worker", () => {
      const result = startWorkerServer({ autoListen: false, setupSignals: false });

      expect(createDlqAutoRetryWorker).toHaveBeenCalled();
      expect(result.dlqAutoRetryWorker.start).toHaveBeenCalled();
      expect(createRemediationDlqWorker).toHaveBeenCalled();
      expect(result.remediationDlqWorker.start).toHaveBeenCalled();
    });

    it("starts scanWorkerPool when scanWorkerEnabled is true", () => {
      startWorkerServer({
        autoListen: false,
        setupSignals: false,
        plan: {
          queues: ["github-webhooks", "outbound-webhooks", "vulnerability-scans"],
          scanWorkerEnabled: true,
          scanConcurrency: 4,
        },
      });

      expect(scanWorkerPool.start).toHaveBeenCalledWith(4);
    });

    it("does not start scanWorkerPool when scanWorkerEnabled is false", () => {
      startWorkerServer({
        autoListen: false,
        setupSignals: false,
        plan: {
          queues: ["github-webhooks", "outbound-webhooks"],
          scanWorkerEnabled: false,
          scanConcurrency: null,
        },
      });

      expect(scanWorkerPool.start).not.toHaveBeenCalled();
    });
  });

  describe("Graceful Shutdown Handling", () => {
    it("configures setupWorkerSignalHandlers with all active workers and drain callbacks", () => {
      const result = startWorkerServer({
        autoListen: false,
        setupSignals: true,
        plan: {
          queues: ["github-webhooks", "outbound-webhooks", "vulnerability-scans"],
          scanWorkerEnabled: true,
          scanConcurrency: 2,
        },
      });

      expect(setupWorkerSignalHandlers).toHaveBeenCalledWith(
        expect.objectContaining({
          workers: [worker, outboundWorker, sbomWorker],
          drain: expect.any(Array),
          timeoutMs: 10000,
          onShutdownComplete: expect.any(Function),
        }),
      );

      // Verify drain contains callbacks for scanWorkerPool, dlqAutoRetryWorker and remediationDlqWorker
      expect(result.drain.length).toBe(3);
      for (const drainFn of result.drain) {
        drainFn();
      }
      expect(scanWorkerPool.stop).toHaveBeenCalled();
      expect(result.dlqAutoRetryWorker.stop).toHaveBeenCalled();
      expect(result.remediationDlqWorker.stop).toHaveBeenCalled();
    });

    it("closes the HTTP server on shutdown completion", () => {
      let registeredOnComplete: (() => void) | undefined;
      vi.mocked(setupWorkerSignalHandlers).mockImplementationOnce(
        (options?: GracefulShutdownOptions) => {
          registeredOnComplete = options?.onShutdownComplete;
        },
      );

      const mockServer = {
        close: vi.fn(),
      } as unknown as Server;

      const app = createWorkerApp();
      vi.spyOn(app, "listen").mockImplementation((...args: unknown[]) => {
        const cb = args.find((arg): arg is () => void => typeof arg === "function");
        if (cb) cb();
        return mockServer;
      });

      startWorkerServer({
        app,
        autoListen: true,
        setupSignals: true,
        plan: {
          queues: ["github-webhooks", "outbound-webhooks"],
          scanWorkerEnabled: false,
          scanConcurrency: null,
        },
      });

      expect(registeredOnComplete).toBeDefined();
      registeredOnComplete!();
      expect(mockServer.close).toHaveBeenCalled();
    });
  });
});
