import { worker } from '../src/lib/queue/worker';
import { outboundWorker } from '../src/lib/queue/outboundWorker';
import { setupWorkerSignalHandlers } from '../src/lib/queue/shutdown';
import express from "express";

const app = express();

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

const server = app.listen(3000, () => {
  console.log("Worker running on 3000");
});

setupWorkerSignalHandlers({
  workers: [worker, outboundWorker],
  timeoutMs: 10000,
  onShutdownComplete: () => {
    server.close();
  },
});