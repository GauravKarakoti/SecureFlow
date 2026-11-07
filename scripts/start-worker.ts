import { worker } from "../src/lib/queue/worker";
import { outboundWorker } from "../src/lib/queue/outboundWorker";
import { sbomWorker } from "../src/lib/queue/sbomWorker";
import { scanWorkerPool } from "../src/lib/queue/workerPool";
import { setupWorkerSignalHandlers } from "../src/lib/queue/shutdown";
import {
  describeWorkerStartup,
  planWorkerStartup,
  type WorkerStartupPlan,
} from "../src/lib/queue/scan-worker-bootstrap";
import { createDlqAutoRetryWorker } from "../src/lib/queue/dlq-auto-retry";
import express, { type Express } from "express";
import type { Server } from "http";

export function createWorkerApp(): Express {
  const app = express();
  app.get("/health", (req, res) => res.status(200).send("OK"));
  return app;
}

export interface StartWorkerOptions {
  app?: Express;
  port?: number;
  plan?: WorkerStartupPlan;
  autoListen?: boolean;
  setupSignals?: boolean;
}

export interface StartWorkerResult {
  app: Express;
  server?: Server;
  plan: WorkerStartupPlan;
  dlqAutoRetryWorker: ReturnType<typeof createDlqAutoRetryWorker>;
  drain: Array<() => Promise<void> | void>;
}

export function startWorkerServer(options: StartWorkerOptions = {}): StartWorkerResult {
  const app = options.app ?? createWorkerApp();
  const plan = options.plan ?? planWorkerStartup();

  worker.on("ready", () => {
    console.log("🚀 BullMQ Worker (Inbound) successfully initialized and waiting for jobs...");
  });

  worker.on("error", (err) => {
    console.error("❌ BullMQ Worker (Inbound) Error:", err);
  });

  outboundWorker.on("ready", () => {
    console.log("🚀 BullMQ Worker (Outbound) successfully initialized and waiting for jobs...");
  });

  outboundWorker.on("error", (err) => {
    console.error("❌ BullMQ Worker (Outbound) Error:", err);
  });

  sbomWorker.on("ready", () => {
    console.log("🚀 BullMQ Worker (SBOM) successfully initialized and waiting for jobs...");
  });

  sbomWorker.on("error", (err) => {
    console.error("❌ BullMQ Worker (SBOM) Error:", err);
  });

  if (plan.scanWorkerEnabled) {
    scanWorkerPool.start(plan.scanConcurrency ?? undefined);
    console.log(`🚀 BullMQ Worker (Scans) started with concurrency=${plan.scanConcurrency}`);
  }

  const dlqAutoRetryWorker = createDlqAutoRetryWorker();
  dlqAutoRetryWorker.start();
  console.log("🔁 DLQ Auto-Retry Worker started");

  // Platforms like Render inject PORT; the keep-alive workflow pings the
  // worker's health endpoint, so binding the wrong port fails health checks.
  const envPort = Number(process.env.PORT);
  const port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 3000);
  let server: Server | undefined;

  if (options.autoListen !== false) {
    server = app.listen(port, () => {
      console.log(`Worker running on ${port}`);
      console.log(`[Worker] ${describeWorkerStartup(plan)}`);
    });
  }

  const drain: Array<() => Promise<void> | void> = [
    ...(plan.scanWorkerEnabled ? [() => scanWorkerPool.stop()] : []),
    () => dlqAutoRetryWorker.stop(),
  ];

  if (options.setupSignals !== false) {
    setupWorkerSignalHandlers({
      workers: [worker, outboundWorker, sbomWorker],
      drain: drain as Array<() => Promise<void>>,
      timeoutMs: 10000,
      onShutdownComplete: () => {
        if (server) {
          server.close();
        }
      },
    });
  }

  return { app, server, plan, dlqAutoRetryWorker, drain };
}

const isMain = process.argv[1] && /start-worker(\.ts|\.js)?$/.test(process.argv[1]);
if (isMain) {
  startWorkerServer();
}
