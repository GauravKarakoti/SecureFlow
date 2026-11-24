import { describe, it, expect, beforeEach } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerError,
  extractCircuitHost,
  getCircuitBreaker,
  clearCircuitBreakerRegistry,
} from "./circuit-breaker";

describe("Outbound Webhook Circuit Breaker (#2061)", () => {
  let currentTime = 1000;
  const mockNow = () => currentTime;

  beforeEach(() => {
    currentTime = 1000;
    clearCircuitBreakerRegistry();
  });

  it("starts in CLOSED state and allows dispatches", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 3,
      cooldownMs: 5000,
      now: mockNow,
    });

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isAllowed()).toBe(true);
    expect(() => cb.assertAllowed()).not.toThrow();
  });

  it("remains CLOSED on successful calls", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 3,
      cooldownMs: 5000,
      now: mockNow,
    });

    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isAllowed()).toBe(true);
  });

  it("transitions CLOSED -> OPEN when consecutive failures reach threshold", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 3,
      cooldownMs: 5000,
      now: mockNow,
    });

    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");

    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");

    // Reaching 3 failures trips the circuit
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.isAllowed()).toBe(false);
    expect(() => cb.assertAllowed()).toThrow(CircuitBreakerError);
  });

  it("transitions OPEN -> HALF_OPEN after cooldown period elapses", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 2,
      cooldownMs: 5000,
      now: mockNow,
    });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    // Advance time by 4999ms (less than cooldown)
    currentTime += 4999;
    expect(cb.getState()).toBe("OPEN");
    expect(cb.isAllowed()).toBe(false);

    // Advance past cooldown threshold (5000ms)
    currentTime += 2;
    expect(cb.getState()).toBe("HALF_OPEN");
    expect(cb.isAllowed()).toBe(true);
  });

  it("transitions HALF_OPEN -> CLOSED on successful probe", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 2,
      cooldownMs: 5000,
      successThreshold: 1,
      now: mockNow,
    });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    currentTime += 5001;
    expect(cb.getState()).toBe("HALF_OPEN");

    // Canary probe succeeds
    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isAllowed()).toBe(true);
  });

  it("transitions HALF_OPEN -> OPEN immediately on failed probe", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 2,
      cooldownMs: 5000,
      now: mockNow,
    });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    currentTime += 5001;
    expect(cb.getState()).toBe("HALF_OPEN");

    // Canary probe fails: should re-trip immediately
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.isAllowed()).toBe(false);
  });

  it("resets failure counter if a success occurs while CLOSED", () => {
    const cb = new CircuitBreaker("https://api.example.com", {
      failureThreshold: 3,
      now: mockNow,
    });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");

    // Intermittent recovery resets consecutive count
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getState()).toBe("CLOSED");
  });

  it("isolates circuit breakers by destination host", () => {
    const cb1 = getCircuitBreaker("https://bad-host.com/hooks/1", {
      failureThreshold: 2,
      now: mockNow,
    });
    const cb2 = getCircuitBreaker("https://good-host.com/hooks/2", {
      failureThreshold: 2,
      now: mockNow,
    });

    cb1.recordFailure();
    cb1.recordFailure();
    expect(cb1.getState()).toBe("OPEN");

    // Good host should remain unaffected
    expect(cb2.getState()).toBe("CLOSED");
    expect(cb2.isAllowed()).toBe(true);
  });

  it("extractCircuitHost normalizes protocol and host", () => {
    expect(extractCircuitHost("https://api.datadoghq.com:8443/v1/webhook?auth=1")).toBe(
      "https://api.datadoghq.com:8443",
    );
    expect(extractCircuitHost("http://internal-sys/hooks")).toBe("http://internal-sys");
  });

  it("manually resets circuit breaker back to CLOSED", () => {
    const cb = new CircuitBreaker("https://api.example.com", { failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    cb.reset();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isAllowed()).toBe(true);
  });
});
