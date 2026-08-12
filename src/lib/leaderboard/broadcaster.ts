/**
 * Shared polling for leaderboard SSE connections.
 *
 * The route previously started its own `setInterval` per connection and cleared it
 * only from an `abort` listener on the request signal. That leaked in two ways:
 * the stream's `cancel()` path — the normal teardown for a closed tab or a proxy
 * dropping the connection — never cleared it, and registering an `abort` listener
 * on an already-aborted signal never fires. A leaked interval kept querying the
 * database every 15 seconds for the life of the process, silently, because the
 * failed `enqueue` was swallowed by an empty `catch`.
 *
 * Aggregation is also identical for every viewer, so N dashboards ran N copies of
 * the same query. One poll now fans out to all subscribers, and stops entirely
 * when the last one leaves.
 */

export type LeaderboardEvent =
  | { type: 'update'; contributors: unknown[]; timestamp: number }
  | { type: 'error'; message: string };

export type LeaderboardSubscriber = (event: LeaderboardEvent) => void;

/** Loads the current standings. Injected so this module stays free of server-only imports. */
export type LeaderboardLoader = (limit: number) => Promise<unknown[]>;

export interface LeaderboardBroadcasterOptions {
  /** Milliseconds between polls. Defaults to 15s, matching the previous behaviour. */
  intervalMs?: number;
  /** Number of contributors to load. */
  limit?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export const DEFAULT_LEADERBOARD_INTERVAL_MS = 15_000;
export const DEFAULT_LEADERBOARD_LIMIT = 50;

export class LeaderboardBroadcaster {
  private readonly subscribers = new Set<LeaderboardSubscriber>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lastEvent: LeaderboardEvent | null = null;

  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(
    private readonly loader: LeaderboardLoader,
    options: LeaderboardBroadcasterOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_LEADERBOARD_INTERVAL_MS;
    this.limit = options.limit ?? DEFAULT_LEADERBOARD_LIMIT;
    this.now = options.now ?? Date.now;
  }

  /** Number of live subscribers. Exposed for tests and diagnostics. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Whether the shared poll timer is currently running. */
  get isPolling(): boolean {
    return this.timer !== null;
  }

  /** The most recent event, so a late subscriber gets data without waiting a full interval. */
  get cachedEvent(): LeaderboardEvent | null {
    return this.lastEvent;
  }

  /**
   * Register `subscriber` and return an idempotent unsubscribe function.
   *
   * The first subscriber starts the shared poll; the last one to leave stops it,
   * so no timer ever outlives the connections that justified it.
   */
  subscribe(subscriber: LeaderboardSubscriber): () => void {
    this.subscribers.add(subscriber);

    if (this.timer === null) {
      this.startPolling();
    }

    let released = false;
    return () => {
      // Idempotent: the route calls this from both `cancel()` and the abort
      // listener, and both can fire for the same connection.
      if (released) return;
      released = true;

      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) {
        this.stopPolling();
      }
    };
  }

  /** Run one poll immediately, outside the timer. */
  async refreshNow(): Promise<void> {
    await this.poll();
  }

  /** Stop the timer and drop all subscribers. Used by tests and shutdown paths. */
  reset(): void {
    this.subscribers.clear();
    this.stopPolling();
    this.lastEvent = null;
  }

  private startPolling(): void {
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);

    // Never let the poll timer be the reason a process stays alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    // A slow aggregation must not stack up behind itself; the next tick is
    // skipped rather than queued.
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const contributors = await this.loader(this.limit);
      this.emit({ type: 'update', contributors, timestamp: this.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load leaderboard data';
      // A transient database error is reported to viewers but does not stop the
      // poll — the next tick may well succeed.
      this.emit({ type: 'error', message });
    } finally {
      this.inFlight = false;
    }
  }

  private emit(event: LeaderboardEvent): void {
    this.lastEvent = event;

    // Iterate a copy: a subscriber may unsubscribe from inside its own callback.
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch {
        // One broken connection must not stop the others from being served.
      }
    }
  }
}

let sharedBroadcaster: LeaderboardBroadcaster | null = null;

/**
 * Process-wide broadcaster, created on first use.
 *
 * The loader is only consulted on creation, so callers all share one poll rather
 * than each standing up their own.
 */
export function getLeaderboardBroadcaster(
  loader: LeaderboardLoader,
  options?: LeaderboardBroadcasterOptions
): LeaderboardBroadcaster {
  if (sharedBroadcaster === null) {
    sharedBroadcaster = new LeaderboardBroadcaster(loader, options);
  }
  return sharedBroadcaster;
}

/** Drop the process-wide instance. Test seam. */
export function resetLeaderboardBroadcaster(): void {
  sharedBroadcaster?.reset();
  sharedBroadcaster = null;
}
