import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  getAiHealthReport,
  tripModelCircuitBreaker,
  resetModelCircuitBreaker,
  clearTelemetry,
  normalizeModelName,
} from "@/ai/telemetry";
import { getModelCircuitBreaker } from "@/ai/resilience";

/**
 * Validates admin authentication.
 */
async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new AppError("Unauthorized admin access", 401);
  }
  return session;
}

/**
 * GET: Telemetry & Status Endpoint
 * Returns real-time circuit breaker states, Redis error counters,
 * sliding-window execution latencies, and failover event history.
 */
async function getHandler(_req: NextRequest) {
  await requireAdmin();

  const report = await getAiHealthReport();
  return NextResponse.json(report, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export interface AdminCircuitActionPayload {
  action: "trip" | "reset" | "clear";
  modelName?: string;
  timeoutMs?: number;
}

/**
 * POST: Admin action to manually trip, reset circuit breakers, or clear metrics.
 */
async function postHandler(req: NextRequest) {
  await requireAdmin();

  let body: AdminCircuitActionPayload;
  try {
    body = await req.json();
  } catch {
    throw new AppError("Invalid JSON body in request", 400);
  }

  const { action, modelName, timeoutMs } = body;

  if (!action || !["trip", "reset", "clear"].includes(action)) {
    throw new AppError('Action must be one of "trip", "reset", or "clear"', 400);
  }

  if (action === "clear") {
    await clearTelemetry();
    const updatedReport = await getAiHealthReport();
    return NextResponse.json(
      {
        message: "AI telemetry and failover history cleared successfully",
        report: updatedReport,
      },
      { status: 200 },
    );
  }

  if (!modelName || typeof modelName !== "string" || modelName.trim() === "") {
    throw new AppError('A valid "modelName" is required for trip and reset actions', 400);
  }

  const normalized = normalizeModelName(modelName);

  if (action === "trip") {
    tripModelCircuitBreaker(normalized, timeoutMs);
    const breaker = getModelCircuitBreaker(normalized);
    return NextResponse.json(
      {
        message: `Circuit breaker manually TRIPPED for model ${normalized}`,
        model: normalized,
        stats: breaker.getStats(),
      },
      { status: 200 },
    );
  }

  if (action === "reset") {
    resetModelCircuitBreaker(normalized);
    const breaker = getModelCircuitBreaker(normalized);
    return NextResponse.json(
      {
        message: `Circuit breaker manually RESET for model ${normalized}`,
        model: normalized,
        stats: breaker.getStats(),
      },
      { status: 200 },
    );
  }

  throw new AppError("Unsupported action", 400);
}

export const GET = withRateLimit(
  withErrorHandler(getHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "admin:ai-health:get" },
);

export const POST = withRateLimit(
  withErrorHandler(postHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "admin:ai-health:post" },
);

export const PATCH = withRateLimit(
  withErrorHandler(postHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.ADMIN, keyPrefix: "admin:ai-health:patch" },
);

