/**
 * AI Model Health & Circuit Breaker Telemetry Engine
 *
 * Records sliding-window execution latencies, error counters, and model failover
 * switch transitions into Redis time-series / lists with memory fallback.
 */

import { redis } from "@/lib/redis";
import {
  getModelCircuitBreaker,
  getAllModelCircuitBreakers,
  tripModelCircuitBreaker,
  resetModelCircuitBreaker,
} from "./resilience";

// Groq and AI default model references (kept decoupled from SDK runtime)
export const DEFAULT_PRIMARY_GROQ_MODEL = "groq/openai/gpt-oss-20b";
export const DEFAULT_FALLBACK_MODELS = [
  "groq/openai/gpt-oss-120b",
  "groq/qwen/qwen3.6-27b",
  "groq/llama-3.1-8b-instant",
  "groq/llama-3.1-70b-versatile",
] as const;


export interface LatencySample {
  timestamp: number;
  durationMs: number;
  success: boolean;
  attempt?: number;
  error?: string;
}

export interface FailoverEvent {
  id: string;
  timestamp: number;
  fromModel: string;
  toModel: string;
  error: string;
  attempt: number;
  fastFail: boolean;
}

export interface ModelHealthStatus {
  modelName: string;
  displayName: string;
  isPrimary: boolean;
  isLocal: boolean;
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN";
  isHealthy: boolean;
  failureCount: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  nextAttemptTimestamp: number;
  totalRequests: number;
  totalSuccesses: number;
  totalErrors: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  recentLatencies: LatencySample[];
}

export interface AiHealthReport {
  timestamp: number;
  primaryModel: string;
  primaryTripped: boolean;
  totalRequests: number;
  totalErrors: number;
  totalFailovers: number;
  overallErrorRate: number;
  models: ModelHealthStatus[];
  recentFailovers: FailoverEvent[];
}

// ── In-Memory Telemetry Fallback Store (for local dev / Redis offline / tests) ─
interface MemoryTelemetryStore {
  counters: Map<string, { requests: number; successes: number; errors: number }>;
  latencies: Map<string, LatencySample[]>;
  failovers: FailoverEvent[];
  registeredModels: Set<string>;
}

const memoryStore: MemoryTelemetryStore = {
  counters: new Map(),
  latencies: new Map(),
  failovers: [],
  registeredModels: new Set(),
};

const MAX_LATENCY_SAMPLES = 60;
const MAX_FAILOVER_EVENTS = 50;
const REDIS_KEY_PREFIX = "ai:health:";

/**
 * Normalizes model names for consistent keying across dashboard and registry.
 */
export function normalizeModelName(name: string): string {
  return String(name).trim();
}

/**
 * Returns a list of known default models in the application.
 */
export function getKnownModels(): string[] {
  const models = new Set<string>();

  // Add default Groq primary and fallback models
  const configuredPrimary = process.env.GROQ_MODEL?.trim();
  if (configuredPrimary) {
    models.add(
      configuredPrimary.startsWith("groq/") ? configuredPrimary : `groq/${configuredPrimary}`,
    );
  }
  models.add(DEFAULT_PRIMARY_GROQ_MODEL);

  for (const m of DEFAULT_FALLBACK_MODELS) {
    models.add(normalizeModelName(m));
  }

  // Add local models if configured
  if (process.env.LOCAL_AI_MODEL) {
    models.add(`openai/${process.env.LOCAL_AI_MODEL}`);
  }

  // Add all currently active breaker models
  for (const model of getAllModelCircuitBreakers().keys()) {
    models.add(normalizeModelName(model));
  }

  // Add all memory registered models
  for (const model of memoryStore.registeredModels) {
    models.add(normalizeModelName(model));
  }

  return Array.from(models);
}


/**
 * Record an individual AI model execution attempt duration and status.
 */
export async function recordModelExecution(
  modelName: string,
  durationMs: number,
  success: boolean,
  attempt = 1,
  error?: unknown,
): Promise<void> {
  const normalized = normalizeModelName(modelName);
  const sample: LatencySample = {
    timestamp: Date.now(),
    durationMs: Math.max(0, Math.round(durationMs)),
    success,
    attempt,
    error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
  };

  // Always update memory store
  memoryStore.registeredModels.add(normalized);
  const curCounters = memoryStore.counters.get(normalized) || {
    requests: 0,
    successes: 0,
    errors: 0,
  };
  curCounters.requests++;
  if (success) {
    curCounters.successes++;
  } else {
    curCounters.errors++;
  }
  memoryStore.counters.set(normalized, curCounters);

  const latList = memoryStore.latencies.get(normalized) || [];
  latList.unshift(sample);
  if (latList.length > MAX_LATENCY_SAMPLES) {
    latList.length = MAX_LATENCY_SAMPLES;
  }
  memoryStore.latencies.set(normalized, latList);

  // If Redis is active, sync asynchronously without blocking or failing execution
  if (redis && typeof redis.pipeline === "function") {
    try {
      const pipe = redis.pipeline();
      const counterKey = `${REDIS_KEY_PREFIX}counters:${normalized}`;
      const latencyKey = `${REDIS_KEY_PREFIX}latencies:${normalized}`;
      const modelsKey = `${REDIS_KEY_PREFIX}models`;

      pipe.sadd(modelsKey, normalized);
      pipe.hincrby(counterKey, "requests", 1);
      if (success) {
        pipe.hincrby(counterKey, "successes", 1);
      } else {
        pipe.hincrby(counterKey, "errors", 1);
      }
      pipe.lpush(latencyKey, JSON.stringify(sample));
      pipe.ltrim(latencyKey, 0, MAX_LATENCY_SAMPLES - 1);
      // Expire keys after 7 days
      pipe.expire(counterKey, 86400 * 7);
      pipe.expire(latencyKey, 86400 * 7);

      await pipe.exec();
    } catch (redisErr) {
      // Quiet failover to memory store on Redis error
    }
  }
}

/**
 * Record a model failover switch transition event.
 */
export async function recordFailoverEvent(event: {
  fromModel: string;
  toModel: string;
  error: unknown;
  attempt: number;
  fastFail?: boolean;
}): Promise<void> {
  const fullEvent: FailoverEvent = {
    id: `failover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    fromModel: normalizeModelName(event.fromModel),
    toModel: normalizeModelName(event.toModel),
    error: event.error
      ? event.error instanceof Error
        ? event.error.message
        : String(event.error)
      : "Unknown error",
    attempt: event.attempt,
    fastFail: Boolean(event.fastFail),
  };

  memoryStore.registeredModels.add(fullEvent.fromModel);
  memoryStore.registeredModels.add(fullEvent.toModel);
  memoryStore.failovers.unshift(fullEvent);
  if (memoryStore.failovers.length > MAX_FAILOVER_EVENTS) {
    memoryStore.failovers.length = MAX_FAILOVER_EVENTS;
  }

  if (redis && typeof redis.lpush === "function") {
    try {
      const failoverKey = `${REDIS_KEY_PREFIX}failovers`;
      const pipe = redis.pipeline();
      pipe.lpush(failoverKey, JSON.stringify(fullEvent));
      pipe.ltrim(failoverKey, 0, MAX_FAILOVER_EVENTS - 1);
      pipe.incr(`${REDIS_KEY_PREFIX}failover_total`);
      pipe.expire(failoverKey, 86400 * 7);
      await pipe.exec();
    } catch {
      // Fallback in memory
    }
  }
}

/**
 * Compute percentile helper (e.g. p95).
 */
function computePercentile(numbers: number[], percentile: number): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * Generates human-friendly display names for models.
 */
export function getModelDisplayName(modelName: string): string {
  if (modelName.startsWith("groq/openai/")) {
    return modelName.replace("groq/openai/", "Groq: OpenAI ");
  }
  if (modelName.startsWith("groq/qwen/")) {
    return modelName.replace("groq/qwen/", "Groq: Qwen ");
  }
  if (modelName.startsWith("groq/")) {
    return modelName.replace("groq/", "Groq: ");
  }
  if (modelName.startsWith("openai/")) {
    return modelName.replace("openai/", "Local AI: ");
  }
  return modelName;
}

/**
 * Collects full AI Health & Circuit Breaker Report across all models.
 */
export async function getAiHealthReport(): Promise<AiHealthReport> {
  const configuredPrimary = process.env.GROQ_MODEL?.trim();
  const primaryModelName = normalizeModelName(
    configuredPrimary
      ? configuredPrimary.startsWith("groq/")
        ? configuredPrimary
        : `groq/${configuredPrimary}`
      : DEFAULT_PRIMARY_GROQ_MODEL,
  );
  const knownModelNames = getKnownModels();

  const modelsSet = new Set<string>(knownModelNames);

  // If Redis is active, load any persisted models
  if (redis && typeof redis.smembers === "function") {
    try {
      const redisModels = await redis.smembers(`${REDIS_KEY_PREFIX}models`);
      if (Array.isArray(redisModels)) {
        for (const m of redisModels) {
          modelsSet.add(normalizeModelName(m));
        }
      }
    } catch {
      // Ignore Redis error
    }
  }

  const modelStatuses: ModelHealthStatus[] = [];
  let totalRequests = 0;
  let totalErrors = 0;

  for (const modelName of modelsSet) {
    const breaker = getModelCircuitBreaker(modelName);
    const breakerStats = breaker.getStats();

    // Retrieve counters & latencies from Redis or Memory
    let requests = 0;
    let successes = 0;
    let errors = 0;
    let recentLatencies: LatencySample[] = [];

    if (redis && typeof redis.hgetall === "function") {
      try {
        const [counterData, latencyData] = await Promise.all([
          redis.hgetall(`${REDIS_KEY_PREFIX}counters:${modelName}`),
          redis.lrange(`${REDIS_KEY_PREFIX}latencies:${modelName}`, 0, MAX_LATENCY_SAMPLES - 1),
        ]);

        if (counterData && Object.keys(counterData).length > 0) {
          requests = parseInt(counterData.requests || "0", 10) || 0;
          successes = parseInt(counterData.successes || "0", 10) || 0;
          errors = parseInt(counterData.errors || "0", 10) || 0;
        } else {
          const mem = memoryStore.counters.get(modelName);
          if (mem) {
            requests = mem.requests;
            successes = mem.successes;
            errors = mem.errors;
          }
        }

        if (Array.isArray(latencyData) && latencyData.length > 0) {
          recentLatencies = latencyData
            .map((item) => {
              try {
                return JSON.parse(item) as LatencySample;
              } catch {
                return null;
              }
            })
            .filter((x): x is LatencySample => x !== null);
        } else {
          recentLatencies = memoryStore.latencies.get(modelName) || [];
        }
      } catch {
        const memCounters = memoryStore.counters.get(modelName);
        if (memCounters) {
          requests = memCounters.requests;
          successes = memCounters.successes;
          errors = memCounters.errors;
        }
        recentLatencies = memoryStore.latencies.get(modelName) || [];
      }
    } else {
      const memCounters = memoryStore.counters.get(modelName);
      if (memCounters) {
        requests = memCounters.requests;
        successes = memCounters.successes;
        errors = memCounters.errors;
      }
      recentLatencies = memoryStore.latencies.get(modelName) || [];
    }

    const durations = recentLatencies.map((s) => s.durationMs);
    const avgLatencyMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    const minLatencyMs = durations.length > 0 ? Math.min(...durations) : 0;
    const maxLatencyMs = durations.length > 0 ? Math.max(...durations) : 0;
    const p95LatencyMs = computePercentile(durations, 95);

    const errorRate = requests > 0 ? Math.round((errors / requests) * 1000) / 10 : 0;

    totalRequests += requests;
    totalErrors += errors;

    const isPrimary = modelName === primaryModelName;
    const isLocal = modelName.includes("local") || modelName.startsWith("openai/qwen");

    modelStatuses.push({
      modelName,
      displayName: getModelDisplayName(modelName),
      isPrimary,
      isLocal,
      circuitState: breakerStats.stateName,
      isHealthy: breakerStats.isHealthy,
      failureCount: breakerStats.failureCount,
      failureThreshold: breakerStats.failureThreshold,
      resetTimeoutMs: breakerStats.resetTimeoutMs,
      nextAttemptTimestamp: breakerStats.nextAttemptTimestamp,
      totalRequests: requests,
      totalSuccesses: successes,
      totalErrors: errors,
      errorRate,
      avgLatencyMs,
      p95LatencyMs,
      minLatencyMs,
      maxLatencyMs,
      recentLatencies: recentLatencies.slice(0, 30),
    });
  }

  // Sort model statuses: primary first, then by requests/activity
  modelStatuses.sort((a, b) => {
    if (a.isPrimary) return -1;
    if (b.isPrimary) return 1;
    return b.totalRequests - a.totalRequests || a.modelName.localeCompare(b.modelName);
  });

  // Fetch recent failover events
  let recentFailovers: FailoverEvent[] = [];
  let totalFailovers = 0;

  if (redis && typeof redis.lrange === "function") {
    try {
      const [redisFailovers, failoverTotal] = await Promise.all([
        redis.lrange(`${REDIS_KEY_PREFIX}failovers`, 0, MAX_FAILOVER_EVENTS - 1),
        redis.get(`${REDIS_KEY_PREFIX}failover_total`),
      ]);

      if (Array.isArray(redisFailovers) && redisFailovers.length > 0) {
        recentFailovers = redisFailovers
          .map((f) => {
            try {
              return JSON.parse(f) as FailoverEvent;
            } catch {
              return null;
            }
          })
          .filter((x): x is FailoverEvent => x !== null);
      } else {
        recentFailovers = memoryStore.failovers;
      }

      totalFailovers = failoverTotal
        ? parseInt(failoverTotal, 10) || recentFailovers.length
        : recentFailovers.length;
    } catch {
      recentFailovers = memoryStore.failovers;
      totalFailovers = memoryStore.failovers.length;
    }
  } else {
    recentFailovers = memoryStore.failovers;
    totalFailovers = memoryStore.failovers.length;
  }

  const primaryBreaker = getModelCircuitBreaker(primaryModelName);
  const primaryTripped = primaryBreaker.getState() !== 0; // Not CLOSED

  const overallErrorRate =
    totalRequests > 0 ? Math.round((totalErrors / totalRequests) * 1000) / 10 : 0;

  return {
    timestamp: Date.now(),
    primaryModel: primaryModelName,
    primaryTripped,
    totalRequests,
    totalErrors,
    totalFailovers,
    overallErrorRate,
    models: modelStatuses,
    recentFailovers: recentFailovers.slice(0, 30),
  };
}

/**
 * Resets in-memory telemetry and cached counters (useful in tests and admin resets).
 */
export async function clearTelemetry(): Promise<void> {
  memoryStore.counters.clear();
  memoryStore.latencies.clear();
  memoryStore.failovers = [];
  memoryStore.registeredModels.clear();

  if (redis && typeof redis.keys === "function") {
    try {
      const keys = await redis.keys(`${REDIS_KEY_PREFIX}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      // Ignore
    }
  }
}

export { tripModelCircuitBreaker, resetModelCircuitBreaker };
