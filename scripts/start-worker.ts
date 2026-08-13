import { worker } from '../src/lib/queue/worker';
import { outboundWorker } from '../src/lib/queue/outboundWorker';
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

app.listen(3000, () => {
  console.log("Worker running on 3000");
})