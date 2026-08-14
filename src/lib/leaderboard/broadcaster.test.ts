import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LeaderboardBroadcaster,
  getLeaderboardBroadcaster,
  resetLeaderboardBroadcaster,
  type LeaderboardEvent,
} from './broadcaster';

const INTERVAL = 15_000;

function makeBroadcaster(loader = vi.fn(async () => [{ login: 'tokyo' }])) {
  return { loader, broadcaster: new LeaderboardBroadcaster(loader, { intervalMs: INTERVAL }) };
}

describe('LeaderboardBroadcaster', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLeaderboardBroadcaster();
  });

  it('does not poll until the first subscriber arrives', () => {
    const { broadcaster, loader } = makeBroadcaster();

    expect(broadcaster.isPolling).toBe(false);
    vi.advanceTimersByTime(INTERVAL * 3);
    expect(loader).not.toHaveBeenCalled();
  });

  it('starts polling on the first subscriber', () => {
    const { broadcaster } = makeBroadcaster();

    broadcaster.subscribe(vi.fn());

    expect(broadcaster.isPolling).toBe(true);
  });

  it('stops polling when the last subscriber leaves', () => {
    const { broadcaster } = makeBroadcaster();

    const off = broadcaster.subscribe(vi.fn());
    off();

    // This is the leak: previously the timer survived teardown and kept
    // querying the database for the life of the process.
    expect(broadcaster.isPolling).toBe(false);
    expect(broadcaster.subscriberCount).toBe(0);
  });

  it('keeps polling while other subscribers remain', () => {
    const { broadcaster } = makeBroadcaster();

    const offA = broadcaster.subscribe(vi.fn());
    broadcaster.subscribe(vi.fn());
    offA();

    expect(broadcaster.isPolling).toBe(true);
    expect(broadcaster.subscriberCount).toBe(1);
  });

  it('runs one shared poll regardless of subscriber count', async () => {
    const { broadcaster, loader } = makeBroadcaster();

    broadcaster.subscribe(vi.fn());
    broadcaster.subscribe(vi.fn());
    broadcaster.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(INTERVAL);

    // Three viewers, one query — not three.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('delivers each update to every subscriber', async () => {
    const { broadcaster } = makeBroadcaster();
    const a = vi.fn();
    const b = vi.fn();

    broadcaster.subscribe(a);
    broadcaster.subscribe(b);
    await broadcaster.refreshNow();

    expect(a).toHaveBeenCalledWith(expect.objectContaining({ type: 'update' }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ type: 'update' }));
  });

  it('makes unsubscribe idempotent', () => {
    const { broadcaster } = makeBroadcaster();

    broadcaster.subscribe(vi.fn());
    const off = broadcaster.subscribe(vi.fn());

    off();
    off();
    off();

    // A double-release must not remove a different subscriber's slot; the route
    // calls this from both cancel() and the abort listener.
    expect(broadcaster.subscriberCount).toBe(1);
  });

  it('stops delivering to an unsubscribed listener', async () => {
    const { broadcaster } = makeBroadcaster();
    const gone = vi.fn();

    const off = broadcaster.subscribe(gone);
    broadcaster.subscribe(vi.fn());
    off();

    await broadcaster.refreshNow();

    expect(gone).not.toHaveBeenCalled();
  });

  it('reports loader failures as an error event and keeps polling', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
    const broadcaster = new LeaderboardBroadcaster(loader, { intervalMs: INTERVAL });
    const received: LeaderboardEvent[] = [];

    broadcaster.subscribe((e) => received.push(e));

    await broadcaster.refreshNow();
    expect(received[0]).toEqual({ type: 'error', message: 'db down' });

    await broadcaster.refreshNow();
    expect(received[1]).toMatchObject({ type: 'update' });
    expect(broadcaster.isPolling).toBe(true);
  });

  it('does not let one throwing subscriber starve the others', async () => {
    const { broadcaster } = makeBroadcaster();
    const healthy = vi.fn();

    broadcaster.subscribe(() => {
      throw new Error('connection gone');
    });
    broadcaster.subscribe(healthy);

    await broadcaster.refreshNow();

    expect(healthy).toHaveBeenCalledOnce();
  });

  it('allows a subscriber to unsubscribe from inside its own callback', async () => {
    const { broadcaster } = makeBroadcaster();

    const off = broadcaster.subscribe(() => off());
    broadcaster.subscribe(vi.fn());

    await expect(broadcaster.refreshNow()).resolves.toBeUndefined();
    expect(broadcaster.subscriberCount).toBe(1);
  });

  it('skips a tick rather than stacking polls when the loader is slow', async () => {
    const pending: Array<(value: unknown[]) => void> = [];
    const loader = vi.fn(() => new Promise<unknown[]>((resolve) => pending.push(resolve)));
    const broadcaster = new LeaderboardBroadcaster(loader, { intervalMs: INTERVAL });

    broadcaster.subscribe(vi.fn());
    void broadcaster.refreshNow();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(loader).toHaveBeenCalledTimes(1);
    pending.forEach((resolve) => resolve([]));
  });

  it('caches the latest event for a late subscriber', async () => {
    const { broadcaster } = makeBroadcaster();

    broadcaster.subscribe(vi.fn());
    await broadcaster.refreshNow();

    expect(broadcaster.cachedEvent).toMatchObject({ type: 'update' });
  });

  it('has no cached event before the first poll', () => {
    const { broadcaster } = makeBroadcaster();
    expect(broadcaster.cachedEvent).toBeNull();
  });

  it('clears everything on reset', async () => {
    const { broadcaster } = makeBroadcaster();

    broadcaster.subscribe(vi.fn());
    await broadcaster.refreshNow();
    broadcaster.reset();

    expect(broadcaster.subscriberCount).toBe(0);
    expect(broadcaster.isPolling).toBe(false);
    expect(broadcaster.cachedEvent).toBeNull();
  });
});

describe('getLeaderboardBroadcaster', () => {
  afterEach(() => {
    resetLeaderboardBroadcaster();
  });

  it('returns the same instance across calls', () => {
    const first = getLeaderboardBroadcaster(async () => []);
    const second = getLeaderboardBroadcaster(async () => []);

    expect(second).toBe(first);
  });

  it('creates a fresh instance after a reset', () => {
    const first = getLeaderboardBroadcaster(async () => []);
    resetLeaderboardBroadcaster();

    expect(getLeaderboardBroadcaster(async () => [])).not.toBe(first);
  });
});
