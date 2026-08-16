import { ScanQueue } from './scanQueue';
import { ScanEngine } from '../scanner/scanEngine';

export class WorkerPool {
  private isRunning: boolean = false;
  private queue: ScanQueue = ScanQueue.getInstance();
  private maxWorkers: number = 4;
  private activeWorkers: number = 0;

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
  }

  stop() {
    this.isRunning = false;
  }

  private async poll() {
    while (this.isRunning) {
      if (this.activeWorkers < this.maxWorkers) {
        const job = await this.queue.popJob();
        if (job) {
          this.activeWorkers++;
          this.processJob(job).finally(() => {
            this.activeWorkers--;
          });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async processJob(job: any) {
    try {
      console.log(`[Worker] Starting job ${job.id} for repo ${job.repositoryId}`);
      await ScanEngine.processScanJob(job.id, job.repositoryId);
      console.log(`[Worker] Finished job ${job.id}`);
    } catch (error) {
      console.error(`[Worker] Job ${job.id} failed:`, error);
    }
  }
}

// Start worker pool singleton on boot
export const globalWorkerPool = new WorkerPool();
