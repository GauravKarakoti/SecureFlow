import { describe, it, expect, beforeEach } from 'vitest';
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
