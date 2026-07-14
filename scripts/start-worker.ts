import { worker } from '../src/lib/queue/worker';
import express from "express";

const app = express();

worker.on('ready', () => {
  console.log('🚀 BullMQ Worker successfully initialized and waiting for jobs...');
});

worker.on('error', (err) => {
  console.error('❌ BullMQ Worker Error:', err);
});

app.listen(3000, () => {
  console.log("Worker running on 3000");
})