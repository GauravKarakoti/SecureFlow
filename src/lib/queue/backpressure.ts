/**
 * Adaptive Watermark Backpressure Controller & Priority Load-Shedding.
 *
 * Protects scan queues from unbounded memory growth and cascading timeouts
 * during traffic spikes by evaluating queue depth utilization against
 * tiered watermarks and shedding lower-priority jobs with Retry-After hints.
 */

export type JobPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "BATCH";

export type BackpressureState = "normal" | "elevated" | "high" | "critical";

export interface BackpressureConfig {
  /** Maximum total waiting jobs before saturation (default: 1000). */
  maxQueueDepth: number;
  /** Utilization ratio [0..1] triggering elevated state (default: 0.6). */
  elevatedRatio: number;
  /** Utilization ratio [0..1] triggering high state (default: 0.8). */
  highRatio: number;
  /** Utilization ratio [0..1] triggering critical state (default: 0.95). */
  criticalRatio: number;
  /** Base Retry-After hint in seconds when shedding (default: 5). */
  baseRetryAfterSeconds: number;
  /** Maximum Retry-After hint in seconds (default: 120). */
  maxRetryAfterSeconds: number;
  /** Optional max fraction of maxQueueDepth a single installation may occupy (default: 0.3). */
  perInstallationMaxShare: number;
  /** Optional p95 latency threshold (ms) that forces at least elevated backpressure. */
  elevatedLatencyP95Ms: number;
  /** Optional p95 latency threshold (ms) that forces at least high backpressure. */
  highLatencyP95Ms: number;
}

export interface BackpressureInput {
  priority?: JobPriority;
  currentDepth: number;
  installationDepth?: number;
  latencyP95Ms?: number;
}

export type BackpressureReason =
  | "admitted"
  | "shed_elevated_watermark"
  | "shed_high_watermark"
  | "shed_critical_watermark"
  | "shed_installation_quota";

export interface BackpressureDecision {
  admitted: boolean;
  state: BackpressureState;
  utilization: number;
  priority: JobPriority;
  retryAfterSeconds: number;
  reason: BackpressureReason;
}

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  maxQueueDepth: 1000,
  elevatedRatio: 0.6,
  highRatio: 0.8,
  criticalRatio: 0.95,
  baseRetryAfterSeconds: 5,
  maxRetryAfterSeconds: 120,
  perInstallationMaxShare: 0.3,
  elevatedLatencyP95Ms: 5_000,
  highLatencyP95Ms: 15_000,
};

const STATE_ORDER: Record<BackpressureState, number> = {
  normal: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};

const ALLOWED_PRIORITIES_BY_STATE: Record<BackpressureState, ReadonlySet<JobPriority>> = {
  normal: new Set<JobPriority>(["CRITICAL", "HIGH", "NORMAL", "LOW", "BATCH"]),
  elevated: new Set<JobPriority>(["CRITICAL", "HIGH", "NORMAL"]),
  high: new Set<JobPriority>(["CRITICAL", "HIGH"]),
  critical: new Set<JobPriority>(["CRITICAL"]),
};

const SHED_REASON_BY_STATE: Record<Exclude<BackpressureState, "normal">, BackpressureReason> = {
  elevated: "shed_elevated_watermark",
  high: "shed_high_watermark",
  critical: "shed_critical_watermark",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function maxState(a: BackpressureState, b: BackpressureState): BackpressureState {
  return STATE_ORDER[a] >= STATE_ORDER[b] ? a : b;
}

/**
 * Compute adaptive Retry-After seconds from queue utilization and backpressure state.
 */
export function computeRetryAfterSeconds(
  utilization: number,
  state: BackpressureState,
  config: BackpressureConfig = DEFAULT_BACKPRESSURE_CONFIG,
): number {
  if (state === "normal") {
    return 0;
  }
  const tierMultiplier = state === "elevated" ? 1 : state === "high" ? 3 : 6;
  const excessRatio = Math.max(0, utilization - config.elevatedRatio);
  const scaleFactor = 1 + excessRatio * 5;
  const raw = Math.ceil(config.baseRetryAfterSeconds * tierMultiplier * scaleFactor);
  return clamp(raw, config.baseRetryAfterSeconds, config.maxRetryAfterSeconds);
}

/**
 * Determine current backpressure state from queue depth and optional p95 latency.
 */
export function resolveBackpressureState(
  currentDepth: number,
  latencyP95Ms?: number,
  config: BackpressureConfig = DEFAULT_BACKPRESSURE_CONFIG,
): { state: BackpressureState; utilization: number } {
  const safeMax = Math.max(1, config.maxQueueDepth);
  const utilization = clamp(currentDepth / safeMax, 0, 1);

  let state: BackpressureState = "normal";
  if (utilization >= config.criticalRatio) {
    state = "critical";
  } else if (utilization >= config.highRatio) {
    state = "high";
  } else if (utilization >= config.elevatedRatio) {
    state = "elevated";
  }

  if (typeof latencyP95Ms === "number" && isFinite(latencyP95Ms)) {
    if (latencyP95Ms >= config.highLatencyP95Ms) {
      state = maxState(state, "high");
    } else if (latencyP95Ms >= config.elevatedLatencyP95Ms) {
      state = maxState(state, "elevated");
    }
  }

  return { state, utilization };
}

/**
 * Stateless watermark & priority admission evaluator.
 */
export function evaluateBackpressureAdmission(
  input: BackpressureInput,
  overrides: Partial<BackpressureConfig> = {},
): BackpressureDecision {
  const config: BackpressureConfig = { ...DEFAULT_BACKPRESSURE_CONFIG, ...overrides };
  const priority: JobPriority = input.priority ?? "NORMAL";
  const { state, utilization } = resolveBackpressureState(
    input.currentDepth,
    input.latencyP95Ms,
    config,
  );

  // Per-installation fairness guard (never blocks CRITICAL jobs)
  if (
    typeof input.installationDepth === "number" &&
    priority !== "CRITICAL" &&
    config.perInstallationMaxShare > 0
  ) {
    const instCap = Math.max(1, Math.floor(config.maxQueueDepth * config.perInstallationMaxShare));
    if (input.installationDepth >= instCap && state !== "normal") {
      return {
        admitted: false,
        state,
        utilization,
        priority,
        retryAfterSeconds: computeRetryAfterSeconds(utilization, state, config),
        reason: "shed_installation_quota",
      };
    }
  }

  const allowed = ALLOWED_PRIORITIES_BY_STATE[state];
  if (allowed.has(priority)) {
    return {
      admitted: true,
      state,
      utilization,
      priority,
      retryAfterSeconds: 0,
      reason: "admitted",
    };
  }

  const shedState = state === "normal" ? "elevated" : state;
  return {
    admitted: false,
    state,
    utilization,
    priority,
    retryAfterSeconds: computeRetryAfterSeconds(utilization, state, config),
    reason: SHED_REASON_BY_STATE[shedState],
  };
}

/**
 * Stateful BackpressureController wrapping configuration and telemetry counters.
 */
export class BackpressureController {
  private readonly config: BackpressureConfig;
  private admittedCount = 0;
  private shedCount = 0;

  constructor(overrides: Partial<BackpressureConfig> = {}) {
    this.config = { ...DEFAULT_BACKPRESSURE_CONFIG, ...overrides };
  }

  public getConfig(): BackpressureConfig {
    return { ...this.config };
  }

  public getState(
    currentDepth: number,
    latencyP95Ms?: number,
  ): {
    state: BackpressureState;
    utilization: number;
  } {
    return resolveBackpressureState(currentDepth, latencyP95Ms, this.config);
  }

  public evaluateAdmission(input: BackpressureInput): BackpressureDecision {
    const decision = evaluateBackpressureAdmission(input, this.config);
    if (decision.admitted) {
      this.admittedCount++;
    } else {
      this.shedCount++;
    }
    return decision;
  }

  public getMetrics(): { admittedCount: number; shedCount: number } {
    return {
      admittedCount: this.admittedCount,
      shedCount: this.shedCount,
    };
  }

  public resetMetrics(): void {
    this.admittedCount = 0;
    this.shedCount = 0;
  }
}
