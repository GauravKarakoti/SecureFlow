export enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

export interface CircuitBreakerStateStorage {
  state: CircuitState;
  failureCount: number;
  nextAttemptTimestamp: number;
}

export interface CircuitBreakerStateStore {
  getState(key: string): Promise<CircuitBreakerStateStorage | null>;
  setState(key: string, state: CircuitBreakerStateStorage, ttlMs?: number): Promise<void>;
  reset(key: string): Promise<void>;
}

export class RedisCircuitBreakerStateStore implements CircuitBreakerStateStore {
  private readonly client: any;
  private readonly keyPrefix: string;

  constructor(client: any, keyPrefix: string = "circuit_breaker:") {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  public async getState(key: string): Promise<CircuitBreakerStateStorage | null> {
    if (!this.client || typeof this.client.get !== "function") return null;
    try {
      const data = await this.client.get(this.fullKey(key));
      if (!data) return null;
      const parsed = JSON.parse(data);
      if (
        typeof parsed.state === "number" &&
        typeof parsed.failureCount === "number" &&
        typeof parsed.nextAttemptTimestamp === "number"
      ) {
        return parsed as CircuitBreakerStateStorage;
      }
      return null;
    } catch {
      return null;
    }
  }

  public async setState(
    key: string,
    state: CircuitBreakerStateStorage,
    ttlMs: number = 60_000,
  ): Promise<void> {
    if (!this.client || typeof this.client.set !== "function") return;
    try {
      const serialized = JSON.stringify(state);
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      await this.client.set(this.fullKey(key), serialized, "EX", ttlSeconds);
    } catch {
      // In-memory fallback
    }
  }

  public async reset(key: string): Promise<void> {
    if (!this.client || typeof this.client.del !== "function") return;
    try {
      await this.client.del(this.fullKey(key));
    } catch {
      // In-memory fallback
    }
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  key?: string;
  store?: CircuitBreakerStateStore;
}

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private nextAttemptTimestamp: number = 0;
  private halfOpenProbeInFlight: boolean = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly key?: string;
  private readonly store?: CircuitBreakerStateStore;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? 30000;
    this.key = options?.key;
    this.store = options?.store;
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttemptTimestamp) {
      this.state = CircuitState.HALF_OPEN;
    }
    return this.state;
  }

  /**
   * Synchronizes internal memory state with the distributed Redis store if configured.
   * Safe to call before checking state or executing tasks.
   */
  public async syncFromStore(): Promise<CircuitState> {
    if (this.store && this.key) {
      try {
        const stored = await this.store.getState(this.key);
        if (stored) {
          this.state = stored.state;
          this.failureCount = stored.failureCount;
          this.nextAttemptTimestamp = stored.nextAttemptTimestamp;
        }
      } catch {
        // Fall back gracefully to in-memory state if remote store read fails
      }
    }
    return this.getState();
  }

  private async persistToStore(): Promise<void> {
    if (this.store && this.key) {
      try {
        const ttlMs = Math.max(this.resetTimeoutMs * 2, 60_000);
        await this.store.setState(
          this.key,
          {
            state: this.state,
            failureCount: this.failureCount,
            nextAttemptTimestamp: this.nextAttemptTimestamp,
          },
          ttlMs,
        );
      } catch {
        // Fall back gracefully to in-memory state on write error
      }
    }
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    if (this.store && this.key) {
      await this.syncFromStore();
    }
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new CircuitBreakerError("Circuit breaker is OPEN");
    }

    // HALF_OPEN admits one probe, not every caller that arrives while it runs.
    const isProbe = currentState === CircuitState.HALF_OPEN;
    if (isProbe) {
      if (this.halfOpenProbeInFlight) {
        throw new CircuitBreakerError("Circuit breaker is HALF_OPEN: a probe is already in flight");
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      if (isProbe) {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  /**
   * Manually trip the circuit breaker into OPEN state.
   */
  public trip(customTimeoutMs?: number): void {
    this.state = CircuitState.OPEN;
    this.failureCount = this.failureThreshold;
    this.nextAttemptTimestamp = Date.now() + (customTimeoutMs ?? this.resetTimeoutMs);
    this.halfOpenProbeInFlight = false;
    this.persistToStore().catch(() => {});
  }

  /**
   * Manually reset the circuit breaker back to CLOSED state.
   */
  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.nextAttemptTimestamp = 0;
    this.halfOpenProbeInFlight = false;
    if (this.store && this.key) {
      this.store.reset(this.key).catch(() => {});
    }
  }

  /**
   * Returns current breaker statistics and operational state.
   */
  public getStats(): {
    state: CircuitState;
    stateName: "CLOSED" | "OPEN" | "HALF_OPEN";
    failureCount: number;
    failureThreshold: number;
    resetTimeoutMs: number;
    nextAttemptTimestamp: number;
    isHealthy: boolean;
  } {
    const currentState = this.getState();
    const stateName: "CLOSED" | "OPEN" | "HALF_OPEN" =
      currentState === CircuitState.CLOSED
        ? "CLOSED"
        : currentState === CircuitState.OPEN
          ? "OPEN"
          : "HALF_OPEN";

    return {
      state: currentState,
      stateName,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      nextAttemptTimestamp: this.nextAttemptTimestamp,
      isHealthy: currentState === CircuitState.CLOSED,
    };
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
    this.persistToStore().catch(() => {});
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttemptTimestamp = Date.now() + this.resetTimeoutMs;
    }
    this.persistToStore().catch(() => {});
  }
}
