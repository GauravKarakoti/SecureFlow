export class ScanQueue {
  private static instance: ScanQueue;
  // Mock Redis Queue implementation for the architectural pattern
  private queue: Map<string, any> = new Map();

  static getInstance(): ScanQueue {
    if (!ScanQueue.instance) {
      ScanQueue.instance = new ScanQueue();
    }
    return ScanQueue.instance;
  }

  async addJob(jobId: string, repositoryId: string): Promise<void> {
    this.queue.set(jobId, { repositoryId, status: 'QUEUED' });
    // In a real implementation, this would push to a Redis BullMQ or similar
  }

  async popJob(): Promise<any> {
    const nextKey = this.queue.keys().next().value;
    if (nextKey) {
      const job = this.queue.get(nextKey);
      this.queue.delete(nextKey);
      return { id: nextKey, ...job };
    }
    return null;
  }
}
