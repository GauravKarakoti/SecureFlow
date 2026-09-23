export enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
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

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? 30000;
  }

  public getState(): CircuitState {
    if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttemptTimestamp) {
      this.state = CircuitState.HALF_OPEN;
    }
    return this.state;
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      throw new CircuitBreakerError("Circuit breaker is OPEN");
    }

    // HALF_OPEN admits one probe, not every caller that arrives while it runs.
    //
    // getState() flips OPEN to HALF_OPEN the moment resetTimeoutMs elapses and
    // leaves it there, so without this gate every request in flight at that
    // instant was let through together. Against a dependency that is still
    // down, each one waits out its own timeout — the breaker stopped shielding
    // the caller exactly when the dependency was least able to answer.
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
      // Released on both paths: onSuccess has closed the circuit, onFailure has
      // reopened it with a fresh deadline, and either way the slot is free.
      if (isProbe) {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttemptTimestamp = Date.now() + this.resetTimeoutMs;
    }
  }
}
