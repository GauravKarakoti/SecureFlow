import { worker } from "../src/lib/queue/worker";
import { outboundWorker } from "../src/lib/queue/outboundWorker";
import { sbomWorker } from "../src/lib/queue/sbomWorker";
import { scanWorkerPool } from "../src/lib/queue/workerPool";
import { setupWorkerSignalHandlers } from "../src/lib/queue/shutdown";
import { describeWorkerStartup, planWorkerStartup } from "../src/lib/queue/scan-worker-bootstrap";
import { createDlqAutoRetryWorker } from "../src/lib/queue/dlq-auto-retry";
import express from "express";

const app = express();

// Resolved before anything is started, so a bad SCAN_WORKER_CONCURRENCY fails
// here with a message rather than reaching BullMQ as NaN.
const plan = planWorkerStartup();

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

// The `vulnerability-scans` queue had a producer — `POST /api/findings` via
// `enqueueScan` — and no consumer, so every job it enqueued sat in Redis while
// its ScanJob row stayed PENDING forever (#750).
if (plan.scanWorkerEnabled) {
  scanWorkerPool.start(plan.scanConcurrency ?? undefined);
  console.log(`🚀 BullMQ Worker (Scans) started with concurrency=${plan.scanConcurrency}`);
}

const dlqAutoRetryWorker = createDlqAutoRetryWorker();
dlqAutoRetryWorker.start();
console.log("🔁 DLQ Auto-Retry Worker started");

const server = app.listen(3000, () => {
  console.log("Worker running on 3000");
  // Stated explicitly: a queue with no consumer looks exactly like a queue with
  // nothing in it, and nothing in the startup output used to say which workers
  // had actually been attached.
  console.log(`[Worker] ${describeWorkerStartup(plan)}`);
});

setupWorkerSignalHandlers({
  workers: [worker, outboundWorker, sbomWorker],
  // `scanWorkerPool` is not a BullMQ `Worker`, so it cannot go in `workers`.
  // Without this a SIGTERM exits with a scan mid-flight still holding its lock.
  drain: [
    ...(plan.scanWorkerEnabled ? [() => scanWorkerPool.stop()] : []),
    () => dlqAutoRetryWorker.stop(),
  ],
  timeoutMs: 10000,
  onShutdownComplete: () => {
    server.close();
  },
});
