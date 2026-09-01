import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gracefulShutdown, isWorkerShuttingDown, resetShutdownState, setupWorkerSignalHandlers } from './shutdown';
import * as queueRedis from './redis';

describe('Graceful Shutdown for Redis Queue Workers (#453)', () => {
  beforeEach(() => {
    resetShutdownState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetShutdownState();
  });

  it('starts in non-shutting-down state and flips state upon shutdown', async () => {
    expect(isWorkerShuttingDown()).toBe(false);

    const mockWorker = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    const closeRedisSpy = vi.spyOn(queueRedis, 'closeQueueRedis').mockResolvedValue(undefined);

    await gracefulShutdown('SIGTERM', {
      workers: [mockWorker as any],
      timeoutMs: 1000,
    });

    expect(isWorkerShuttingDown()).toBe(true);
    expect(mockWorker.close).toHaveBeenCalledTimes(1);
    expect(closeRedisSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate shutdown signals while shutdown is in progress', async () => {
    const mockWorker = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const closeRedisSpy = vi.spyOn(queueRedis, 'closeQueueRedis').mockResolvedValue(undefined);

    await gracefulShutdown('SIGINT', {
      workers: [mockWorker as any],
      timeoutMs: 1000,
    });

    await gracefulShutdown('SIGTERM', {
      workers: [mockWorker as any],
      timeoutMs: 1000,
    });

    expect(mockWorker.close).toHaveBeenCalledTimes(1);
    expect(closeRedisSpy).toHaveBeenCalledTimes(1);
  });

  it('calls onShutdownComplete callback when sequence completes', async () => {
    const onComplete = vi.fn();
    vi.spyOn(queueRedis, 'closeQueueRedis').mockResolvedValue(undefined);

    await gracefulShutdown('SIGTERM', {
      workers: [],
      onShutdownComplete: onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('drains a non-Worker like the scan pool before closing Redis (#750)', async () => {
    // `scanWorkerPool` is not a BullMQ `Worker` — it wraps one privately and
    // exposes `stop()` — so it could not be passed in `workers` at all, and a
    // SIGTERM exited with a scan mid-flight still holding its lock.
    const order: string[] = [];
    const closeRedisSpy = vi
      .spyOn(queueRedis, 'closeQueueRedis')
      .mockImplementation(async () => {
        order.push('redis');
      });

    const stopScanPool = vi.fn().mockImplementation(async () => {
      order.push('scan-pool');
    });

    await gracefulShutdown('SIGTERM', { workers: [], drain: [stopScanPool] });

    expect(stopScanPool).toHaveBeenCalledTimes(1);
    expect(closeRedisSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['scan-pool', 'redis']);
  });

  it('drains every entry even when one of them throws', async () => {
    vi.spyOn(queueRedis, 'closeQueueRedis').mockResolvedValue(undefined);

    const failing = vi.fn().mockRejectedValue(new Error('scan pool refused to stop'));
    const succeeding = vi.fn().mockResolvedValue(undefined);

    await gracefulShutdown('SIGTERM', { workers: [], drain: [failing, succeeding] });

    expect(failing).toHaveBeenCalledTimes(1);
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(queueRedis.closeQueueRedis).toHaveBeenCalledTimes(1);
  });

  it('is unchanged when nothing extra needs draining', async () => {
    const onComplete = vi.fn();
    vi.spyOn(queueRedis, 'closeQueueRedis').mockResolvedValue(undefined);

    await gracefulShutdown('SIGTERM', { workers: [], onShutdownComplete: onComplete });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('registers SIGINT and SIGTERM event listeners', () => {
    const onceSpy = vi.spyOn(process, 'once');

    setupWorkerSignalHandlers();

    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});
