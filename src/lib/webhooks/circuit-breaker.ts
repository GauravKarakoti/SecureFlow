/**
/**
 * Outbound Webhook Circuit Breaker Engine (#2061)
 *
 * Implements a state machine (CLOSED -> OPEN -> HALF_OPEN -> CLOSED) to protect
 * outbound webhook workers from cascading socket exhaustion and thread starvation
 * during downstream endpoint outages.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping from CLOSED to OPEN (default: 5) */
  failureThreshold?: number;
  /** Cooldown time in milliseconds before probing downstream from OPEN to HALF_OPEN (default: 30,000ms) */
  cooldownMs?: number;
  /** Number of successful probe calls in HALF_OPEN required to transition back to CLOSED (default: 1) */
  successThreshold?: number;
  /** Custom clock function for deterministic testing */
  now?: () => number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
  totalTripped: number;
}

export class CircuitBreakerError extends Error {
  readonly host: string;
  readonly state: CircuitState;
  readonly cooldownRemainingMs: number;

  constructor(host: string, cooldownRemainingMs: number) {
    super(
      `[CircuitBreaker] Outbound webhook dispatch to "${host}" fast-failed: circuit is OPEN (${Math.ceil(
        cooldownRemainingMs / 1000,
      )}s cooldown remaining).`,
    );
    this.name = "CircuitBreakerError";
    this.host = host;
    this.state = "OPEN";
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private totalTripped = 0;

  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly successThreshold: number;
  private readonly now: () => number;

  constructor(
    readonly host: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Return the current state of the circuit breaker.
   * If in OPEN state and cooldown period has elapsed, transitions to HALF_OPEN.
   */
  getState(): CircuitState {
    if (this.state === "OPEN" && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        this.consecutiveSuccesses = 0;
      }
    }
    return this.state;
  }

  /**
   * Check if a request to the target host is permitted.
   * Returns true if CLOSED or HALF_OPEN (probe allowed).
   * Returns false if OPEN and still in cooldown.
   */
  isAllowed(): boolean {
    const currentState = this.getState();
    return currentState !== "OPEN";
  }

  /**
   * Asserts whether a request is allowed, throwing CircuitBreakerError if OPEN.
   */
  assertAllowed(): void {
    if (!this.isAllowed()) {
      const remaining = Math.max(0, this.cooldownMs - (this.now() - (this.openedAt ?? 0)));
      throw new CircuitBreakerError(this.host, remaining);
    }
  }

  /**
   * Record a successful outbound HTTP call.
   */
  recordSuccess(): void {
    const timestamp = this.now();
    this.lastSuccessAt = timestamp;
    this.totalSuccesses++;

    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.openedAt = null;
      }
    } else if (this.state === "CLOSED") {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failed outbound HTTP call (5xx status, timeout, network error).
   */
  recordFailure(): void {
    const timestamp = this.now();
    this.lastFailureAt = timestamp;
    this.totalFailures++;

    if (this.state === "HALF_OPEN") {
      // Canary/probe failed: trip immediately back to OPEN
      this.state = "OPEN";
      this.openedAt = timestamp;
      this.consecutiveSuccesses = 0;
      this.totalTripped++;
    } else if (this.state === "CLOSED") {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = "OPEN";
        this.openedAt = timestamp;
        this.totalTripped++;
      }
    } else if (this.state === "OPEN") {
      // Re-trip or update timestamp
      this.openedAt = timestamp;
    }
  }

  /**
   * Manually reset the circuit breaker back to healthy CLOSED state.
   */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
  }

  /**
   * Export telemetry statistics.
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAt: this.openedAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      totalTripped: this.totalTripped,
    };
  }
}

/**
 * Extracts normalized host:port key from a URL for circuit isolation.
 */
export function extractCircuitHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

/**
 * In-memory registry of circuit breakers keyed by host.
 */
const registry = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(
  urlOrHost: string,
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  const host = extractCircuitHost(urlOrHost);
  let breaker = registry.get(host);
  if (!breaker) {
    breaker = new CircuitBreaker(host, options);
    registry.set(host, breaker);
  }
  return breaker;
}

export function resetAllCircuitBreakers(): void {
  for (const breaker of registry.values()) {
    breaker.reset();
  }
}

export function clearCircuitBreakerRegistry(): void {
  registry.clear();
}
