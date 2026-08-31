import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamManager, streamManager } from './streamManager';

describe('StreamManager', () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager();
  });

  describe('register', () => {
    it('returns a connection ID and signal', () => {
      const { id, signal } = manager.register();
      expect(id).toMatch(/^sse-\d+$/);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('increments the connection counter', () => {
      manager.register();
      manager.register();
      expect(manager.getStats().activeConnections).toBe(2);
    });

    it('increments totalRegistered', () => {
      manager.register();
      manager.register();
      expect(manager.getStats().totalRegistered).toBe(2);
    });

    it('stores optional label', () => {
      const { id } = manager.register(undefined, 'test-route');
      // Label is stored but not exposed via public API directly
      expect(id).toBeTruthy();
    });
  });

  describe('upstream signal integration', () => {
    it('aborts the controller when upstream signal fires', () => {
      const upstream = new AbortController();
      const { signal } = manager.register(upstream.signal);

      expect(signal.aborted).toBe(false);
      upstream.abort();
      expect(signal.aborted).toBe(true);
    });

    it('unregisters the connection when upstream signal fires', () => {
      const upstream = new AbortController();
      manager.register(upstream.signal);

      expect(manager.getStats().activeConnections).toBe(1);
      upstream.abort();
      expect(manager.getStats().activeConnections).toBe(0);
    });

    it('increments totalCleanedUp on disconnect', () => {
      const upstream = new AbortController();
      manager.register(upstream.signal);

      expect(manager.getStats().totalCleanedUp).toBe(0);
      upstream.abort();
      expect(manager.getStats().totalCleanedUp).toBe(1);
    });

    it('immediately cleans up if upstream signal is already aborted', () => {
      const upstream = new AbortController();
      upstream.abort();

      const { signal } = manager.register(upstream.signal);
      expect(signal.aborted).toBe(true);
      expect(manager.getStats().activeConnections).toBe(0);
    });

    it('works without an upstream signal', () => {
      const { signal } = manager.register();
      expect(signal.aborted).toBe(false);
      expect(manager.getStats().activeConnections).toBe(1);
    });
  });

  describe('unregister', () => {
    it('aborts the controller and removes the connection', () => {
      const { id, signal } = manager.register();
      expect(manager.getStats().activeConnections).toBe(1);

      manager.unregister(id);
      expect(signal.aborted).toBe(true);
      expect(manager.getStats().activeConnections).toBe(0);
    });

    it('is safe to call with unknown ID', () => {
      manager.unregister('sse-999');
      expect(manager.getStats().activeConnections).toBe(0);
    });

    it('is safe to call multiple times', () => {
      const { id } = manager.register();
      manager.unregister(id);
      manager.unregister(id); // second call should not throw
      expect(manager.getStats().activeConnections).toBe(0);
    });
  });

  describe('getController / getSignal', () => {
    it('returns the controller for a valid ID', () => {
      const { id } = manager.register();
      const controller = manager.getController(id);
      expect(controller).toBeInstanceOf(AbortController);
    });

    it('returns undefined for unknown ID', () => {
      expect(manager.getController('sse-999')).toBeUndefined();
    });

    it('returns the signal for a valid ID', () => {
      const { id, signal } = manager.register();
      expect(manager.getSignal(id)).toBe(signal);
    });

    it('returns undefined signal for unknown ID', () => {
      expect(manager.getSignal('sse-999')).toBeUndefined();
    });
  });

  describe('isActive', () => {
    it('returns true for active connection', () => {
      const { id } = manager.register();
      expect(manager.isActive(id)).toBe(true);
    });

    it('returns false after unregister', () => {
      const { id } = manager.register();
      manager.unregister(id);
      expect(manager.isActive(id)).toBe(false);
    });

    it('returns false for unknown ID', () => {
      expect(manager.isActive('sse-999')).toBe(false);
    });

    it('returns false after upstream abort', () => {
      const upstream = new AbortController();
      const { id } = manager.register(upstream.signal);
      upstream.abort();
      expect(manager.isActive(id)).toBe(false);
    });
  });

  describe('getStats', () => {
    it('starts with zero stats', () => {
      const stats = manager.getStats();
      expect(stats.activeConnections).toBe(0);
      expect(stats.totalRegistered).toBe(0);
      expect(stats.totalCleanedUp).toBe(0);
      expect(stats.oldestConnectionMs).toBeNull();
    });

    it('tracks oldest connection age', async () => {
      manager.register();
      // Small delay to create measurable age difference
      await new Promise((r) => setTimeout(r, 5));
      manager.register();

      const stats = manager.getStats();
      expect(stats.oldestConnectionMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getActiveIds', () => {
    it('returns empty array when no connections', () => {
      expect(manager.getActiveIds()).toEqual([]);
    });

    it('returns all active connection IDs', () => {
      const { id: id1 } = manager.register();
      const { id: id2 } = manager.register();
      expect(manager.getActiveIds()).toContain(id1);
      expect(manager.getActiveIds()).toContain(id2);
    });

    it('removes ID after unregister', () => {
      const { id } = manager.register();
      manager.unregister(id);
      expect(manager.getActiveIds()).not.toContain(id);
    });
  });

  describe('abortAll', () => {
    it('aborts all active connections', () => {
      const { signal: sig1 } = manager.register();
      const { signal: sig2 } = manager.register();

      manager.abortAll();

      expect(sig1.aborted).toBe(true);
      expect(sig2.aborted).toBe(true);
      expect(manager.getStats().activeConnections).toBe(0);
    });
  });
});

describe('streamManager singleton', () => {
  it('is a StreamManager instance', () => {
    expect(streamManager).toBeInstanceOf(StreamManager);
  });
});

describe('release (#722)', () => {
  it('is returned alongside the id and signal', () => {
    const m = new StreamManager();
    const reg = m.register();

    expect(typeof reg.release).toBe('function');
    expect(typeof reg.id).toBe('string');
    expect(reg.signal).toBeInstanceOf(AbortSignal);
  });

  it('unregisters and aborts', () => {
    const m = new StreamManager();
    const { signal, release } = m.register();

    release();

    expect(signal.aborted).toBe(true);
    expect(m.getStats().activeConnections).toBe(0);
  });

  it('is idempotent, so a finally block can call it unconditionally', () => {
    const m = new StreamManager();
    const { release } = m.register();

    release();
    release();
    release();

    expect(m.getStats().totalCleanedUp).toBe(1);
  });

  it('still releases after the caller has stopped writing to its stream', () => {
    // The route bug: `send` sets `closed = true` on a failed enqueue, and
    // `finish()` opened with `if (closed) return` -- so every later finish()
    // returned at the guard and unregister was never reached. Cleanup must
    // not be reachable only through that flag.
    const m = new StreamManager();
    const { release } = m.register(undefined, 'explain-stream');

    let closed = false;
    const send = () => {
      closed = true; // enqueue threw
    };
    const finish = () => {
      release();
      if (closed) return;
      closed = true;
    };

    send();
    finish();

    expect(m.getStats().activeConnections).toBe(0);
  });
});

describe('upstream listener detachment (#722)', () => {
  it('detaches the abort listener when a connection is released', () => {
    // Before: `cleanup` deleted the entry but left the listener attached, so
    // the closure stayed on the signal's listener list for the life of the
    // signal. Five registrations released, then an abort, used to re-enter
    // cleanup five times into no-ops.
    const m = new StreamManager();
    const controller = new AbortController();

    const releases = Array.from({ length: 5 }, () => m.register(controller.signal).release);
    releases.forEach((release) => release());

    const cleanedBefore = m.getStats().totalCleanedUp;
    controller.abort();

    expect(m.getStats().totalCleanedUp).toBe(cleanedBefore);
    expect(m.getStats().activeConnections).toBe(0);
  });

  it('still cleans up on abort when the connection was not released first', () => {
    const m = new StreamManager();
    const controller = new AbortController();
    const { signal } = m.register(controller.signal);

    controller.abort();

    expect(signal.aborted).toBe(true);
    expect(m.getStats().activeConnections).toBe(0);
    expect(m.getStats().totalCleanedUp).toBe(1);
  });

  it('counts one cleanup per connection, not one per abort path', () => {
    const m = new StreamManager();
    const controller = new AbortController();
    const { release } = m.register(controller.signal);

    controller.abort();
    release();

    expect(m.getStats().totalCleanedUp).toBe(1);
  });

  it('does not disturb other listeners on the same signal', () => {
    const m = new StreamManager();
    const controller = new AbortController();
    const unrelated = vi.fn();
    controller.signal.addEventListener('abort', unrelated);

    m.register(controller.signal).release();
    controller.abort();

    expect(unrelated).toHaveBeenCalledTimes(1);
  });
});

describe('capacity bound (#722)', () => {
  it('holds the registry at maxConnections', () => {
    // Was unbounded: 10,000 signal-less registrations sat in the map with
    // nothing able to clean them up.
    const m = new StreamManager({ maxConnections: 10 });

    for (let i = 0; i < 500; i++) m.register(undefined, 'no-signal');

    expect(m.getStats().activeConnections).toBe(10);
    expect(m.getStats().totalRegistered).toBe(500);
  });

  it('evicts the oldest first', () => {
    const m = new StreamManager({ maxConnections: 3 });
    const first = m.register();
    m.register();
    m.register();

    const newest = m.register();

    expect(m.isActive(first.id)).toBe(false);
    expect(m.isActive(newest.id)).toBe(true);
  });

  it('aborts what it evicts, so the work behind it stops', () => {
    const m = new StreamManager({ maxConnections: 1 });
    const evicted = m.register();

    m.register();

    expect(evicted.signal.aborted).toBe(true);
  });

  it('counts evictions separately from ordinary cleanups', () => {
    // Cap 2: the first two register freely, and each of the next three evicts
    // one to make room.
    const m = new StreamManager({ maxConnections: 2 });
    for (let i = 0; i < 5; i++) m.register();

    expect(m.getStats().totalEvicted).toBe(3);
    expect(m.getStats().activeConnections).toBe(2);
  });

  it('treats a cap below one as one', () => {
    const m = new StreamManager({ maxConnections: 0 });
    m.register();

    expect(m.getStats().activeConnections).toBe(1);
  });
});

/** Age a tracked connection by `ms`, so a sweep can be tested without waiting. */
function backdate(manager: StreamManager, id: string, ms: number): void {
  const connections = (
    manager as unknown as { connections: Map<string, { registeredAt: number }> }
  ).connections;
  const conn = connections.get(id);
  if (conn) conn.registeredAt -= ms;
}

describe('idle sweep (#722)', () => {
  it('drops connections older than maxAgeMs', () => {
    const m = new StreamManager({ maxAgeMs: 1000 });
    const stale = m.register();

    expect(m.reapExpired(Date.now() + 5000)).toBe(1);
    expect(m.isActive(stale.id)).toBe(false);
    expect(m.getStats().totalReaped).toBe(1);
  });

  it('keeps connections inside the window', () => {
    const m = new StreamManager({ maxAgeMs: 60_000 });
    const fresh = m.register();

    expect(m.reapExpired(Date.now() + 1000)).toBe(0);
    expect(m.isActive(fresh.id)).toBe(true);
  });

  it('aborts what it reaps', () => {
    const m = new StreamManager({ maxAgeMs: 1 });
    const { signal } = m.register();

    m.reapExpired(Date.now() + 5000);

    expect(signal.aborted).toBe(true);
  });

  it('stops at the first connection young enough to keep', () => {
    // Insertion order is registration order, so the sweep is O(expired), not
    // O(registry) -- it must not walk every entry on every registration.
    const m = new StreamManager({ maxAgeMs: 1000 });
    const old = m.register();
    const recent = m.register();
    backdate(m, old.id, 10_000);

    expect(m.reapExpired()).toBe(1);
    expect(m.isActive(recent.id)).toBe(true);
  });

  it('runs on registration, so nothing has to schedule it', () => {
    // Deliberately not a setInterval: a timer in a module-level singleton
    // keeps the Node process alive, which is a leak of the same kind.
    const m = new StreamManager({ maxAgeMs: 1000 });
    const stale = m.register();
    backdate(m, stale.id, 10_000);

    m.register();

    expect(m.isActive(stale.id)).toBe(false);
    expect(m.getStats().totalReaped).toBe(1);
  });
});

describe('stats', () => {
  it('starts every counter at zero', () => {
    expect(new StreamManager().getStats()).toEqual({
      activeConnections: 0,
      totalRegistered: 0,
      totalCleanedUp: 0,
      totalEvicted: 0,
      totalReaped: 0,
      oldestConnectionMs: null,
    });
  });
});
