import { worker } from '../src/lib/queue/worker';
import { outboundWorker } from '../src/lib/queue/outboundWorker';
import { scanWorkerPool } from '../src/lib/queue/workerPool';
import { setupWorkerSignalHandlers } from '../src/lib/queue/shutdown';
import {
  describeWorkerStartup,
  planWorkerStartup,
} from '../src/lib/queue/scan-worker-bootstrap';
import express from "express";

const app = express();

// Resolved before anything is started, so a bad SCAN_WORKER_CONCURRENCY fails
// here with a message rather than reaching BullMQ as NaN.
const plan = planWorkerStartup();

worker.on('ready', () => {
  console.log('🚀 BullMQ Worker (Inbound) successfully initialized and waiting for jobs...');
});

worker.on('error', (err) => {
  console.error('❌ BullMQ Worker (Inbound) Error:', err);
});

outboundWorker.on('ready', () => {
  console.log('🚀 BullMQ Worker (Outbound) successfully initialized and waiting for jobs...');
});

outboundWorker.on('error', (err) => {
  console.error('❌ BullMQ Worker (Outbound) Error:', err);
});

// The `vulnerability-scans` queue had a producer — `POST /api/findings` via
// `enqueueScan` — and no consumer, so every job it enqueued sat in Redis while
// its ScanJob row stayed PENDING forever (#750).
if (plan.scanWorkerEnabled) {
  scanWorkerPool.start();
  console.log(
    `🚀 BullMQ Worker (Scans) started with concurrency=${plan.scanConcurrency}`
  );
}

const server = app.listen(3000, () => {
  console.log("Worker running on 3000");
  // Stated explicitly: a queue with no consumer looks exactly like a queue with
  // nothing in it, and nothing in the startup output used to say which workers
  // had actually been attached.
  console.log(`[Worker] ${describeWorkerStartup(plan)}`);
});

setupWorkerSignalHandlers({
  workers: [worker, outboundWorker],
  // `scanWorkerPool` is not a BullMQ `Worker`, so it cannot go in `workers`.
  // Without this a SIGTERM exits with a scan mid-flight still holding its lock.
  drain: plan.scanWorkerEnabled ? [() => scanWorkerPool.stop()] : [],
  timeoutMs: 10000,
  onShutdownComplete: () => {
    server.close();
  },
});
