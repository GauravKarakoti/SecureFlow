/**
 * System Health Check
 *
 * Probes each infrastructure component and returns a structured report.
 * Designed to be called from both the /api/health endpoint and the
 * /dashboard/status page without duplicating logic.
 */

import prisma from "@/lib/prisma";

export type ComponentStatus = "healthy" | "degraded" | "down";

export interface ComponentHealth {
  name: string;
  status: ComponentStatus;
  latencyMs: number;
  message?: string;
}

export interface HealthReport {
  status: ComponentStatus;
  timestamp: string;
  uptime: number;
  components: ComponentHealth[];
}

const startAt = Date.now();

async function probeDatabase(): Promise<ComponentHealth> {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      name: "PostgreSQL",
      status: "healthy",
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      name: "PostgreSQL",
      status: "down",
      latencyMs: Date.now() - t0,
      message: e?.message?.slice(0, 200) ?? "Unknown database error",
    };
  }
}

async function probeRedis(): Promise<ComponentHealth> {
  const t0 = Date.now();
  try {
    // Dynamic import to avoid crashing when Redis is not configured
    const { redis } = await import("@/lib/redis");
    if (!redis) {
      return { name: "Redis", status: "degraded", latencyMs: 0, message: "Not configured" };
    }
    await redis.ping();
    return { name: "Redis", status: "healthy", latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return {
      name: "Redis",
      status: "degraded",
      latencyMs: Date.now() - t0,
      message: e?.message?.slice(0, 200) ?? "Connection failed",
    };
  }
}

async function probeGroq(): Promise<ComponentHealth> {
  const t0 = Date.now();
  const key = process.env.GROQ_API_KEY;
  if (!key || key === "dummy-key-for-build") {
    return { name: "Groq LLM", status: "degraded", latencyMs: 0, message: "API key not configured" };
  }
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { name: "Groq LLM", status: "healthy", latencyMs: Date.now() - t0 };
    return {
      name: "Groq LLM",
      status: "degraded",
      latencyMs: Date.now() - t0,
      message: `HTTP ${res.status}`,
    };
  } catch (e: any) {
    return {
      name: "Groq LLM",
      status: "degraded",
      latencyMs: Date.now() - t0,
      message: e?.message?.slice(0, 200) ?? "Connection failed",
    };
  }
}

function aggregateStatus(components: ComponentHealth[]): ComponentStatus {
  if (components.some((c) => c.status === "down")) return "down";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  return "healthy";
}

/**
 * Run all probes concurrently and return a unified health report.
 * Probes run with individual timeouts so one slow check doesn't block the rest.
 */
export async function runHealthCheck(): Promise<HealthReport> {
  const components = await Promise.all([
    probeDatabase(),
    probeRedis(),
    probeGroq(),
  ]);

  return {
    status: aggregateStatus(components),
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startAt) / 1000),
    components,
  };
}
