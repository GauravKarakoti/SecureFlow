import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";

export type WebhookOutcome = "queued" | "scanned" | "ignored" | "rejected";

export const WEBHOOK_OUTCOMES: readonly WebhookOutcome[] = [
  "queued",
  "scanned",
  "ignored",
  "rejected",
] as const;

export const WEBHOOK_REASON_CODES = {
  // Accepted & In-Flight / Completed
  QUEUED: "QUEUED",
  SCANNED: "SCANNED",

  // Ignored (Healthy filtering / skipping)
  PING: "PING",
  UNTRACKED_EVENT: "UNTRACKED_EVENT",
  UNTRACKED_ACTION: "UNTRACKED_ACTION",
  FOREIGN_CHECK: "FOREIGN_CHECK",
  DUPLICATE: "DUPLICATE",
  DRAFT_PR: "DRAFT_PR",
  AUTHOR_SKIPPED: "AUTHOR_SKIPPED",
  REPO_DISABLED: "REPO_DISABLED",
  METADATA_ONLY: "METADATA_ONLY",
  UNKNOWN_USER: "UNKNOWN_USER",
  NO_REPOSITORIES: "NO_REPOSITORIES",
  NO_DIFF_CHANGES: "NO_DIFF_CHANGES",

  // Rejected (Errors / Invalid requests)
  BAD_SIGNATURE: "BAD_SIGNATURE",
  MISSING_SIGNATURE: "MISSING_SIGNATURE",
  MISSING_DELIVERY_ID: "MISSING_DELIVERY_ID",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  MISSING_INSTALLATION: "MISSING_INSTALLATION",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SCAN_FAILED: "SCAN_FAILED",
} as const;

export type WebhookReasonCode = keyof typeof WEBHOOK_REASON_CODES | (string & {});

export interface RecordDeliveryInput {
  deliveryId: string;
  eventType: string;
  action?: string | null;
  repository?: string | null;
  outcome: WebhookOutcome;
  reasonCode: WebhookReasonCode;
  error?: string | null;
  createdAt?: Date;
}

export interface ListWebhookDeliveriesOptions {
  repository?: string;
  outcome?: string;
  reasonCode?: string;
  search?: string;
  limit?: number;
  offset?: number;
  days?: number;
  startDate?: Date;
}

export interface WebhookDeliveryStats {
  total: number;
  queued: number;
  scanned: number;
  ignored: number;
  rejected: number;
}

/** Default retention window in days for webhook delivery diagnostics */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;

/** Rate-limiting configurations for delivery writes */
const WRITE_RATE_LIMITS = {
  REJECTED_PER_MINUTE: 60,
  TOTAL_PER_MINUTE: 300,
};

// In-memory sliding window tracking write rate limits to defend against DDoS or floods
interface RateCounter {
  count: number;
  resetAt: number;
}

const writeCounters: {
  rejected: RateCounter;
  total: RateCounter;
} = {
  rejected: { count: 0, resetAt: Date.now() + 60_000 },
  total: { count: 0, resetAt: Date.now() + 60_000 },
};

/** Reset rate limit counters (for testing) */
export function _resetDeliveryRateLimitsForTest() {
  const now = Date.now();
  writeCounters.rejected = { count: 0, resetAt: now + 60_000 };
  writeCounters.total = { count: 0, resetAt: now + 60_000 };
}

/** Check and increment write rate limit */
function checkWriteRateLimit(outcome: WebhookOutcome): boolean {
  const now = Date.now();

  // Reset expired windows
  if (now > writeCounters.total.resetAt) {
    writeCounters.total = { count: 0, resetAt: now + 60_000 };
  }
  if (now > writeCounters.rejected.resetAt) {
    writeCounters.rejected = { count: 0, resetAt: now + 60_000 };
  }

  // Check total ceiling
  if (writeCounters.total.count >= WRITE_RATE_LIMITS.TOTAL_PER_MINUTE) {
    return false;
  }

  // Check rejected ceiling
  if (
    outcome === "rejected" &&
    writeCounters.rejected.count >= WRITE_RATE_LIMITS.REJECTED_PER_MINUTE
  ) {
    return false;
  }

  // Increment counters
  writeCounters.total.count += 1;
  if (outcome === "rejected") {
    writeCounters.rejected.count += 1;
  }

  return true;
}

/**
 * Sanitize error message to guarantee NO secrets, auth tokens, or payload bodies
 * are ever persisted to the database.
 */
export function sanitizeDeliveryError(text?: string | null): string | null {
  if (!text) return null;
  let sanitized = String(text).trim();

  // Redact potential bearer tokens, secret patterns, or private keys
  sanitized = sanitized
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(
      /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(
      /([a-zA-Z0-9_\-\.]*secret[a-zA-Z0-9_\-\.]*\s*[:=]\s*)(['"]?)([^'"\s]+)\2/gi,
      "$1[REDACTED_SECRET]",
    )
    .replace(
      /([a-zA-Z0-9_\-\.]*password[a-zA-Z0-9_\-\.]*\s*[:=]\s*)(['"]?)([^'"\s]+)\2/gi,
      "$1[REDACTED_PASSWORD]",
    );

  // Truncate to maximum 300 characters
  if (sanitized.length > 300) {
    sanitized = sanitized.slice(0, 299) + "…";
  }

  return sanitized || null;
}

/**
 * Sanitize repository name string (e.g. "owner/repo").
 */
export function sanitizeRepository(repo?: string | null): string | null {
  if (!repo) return null;
  const trimmed = String(repo).trim();
  if (trimmed.length > 150) {
    return trimmed.slice(0, 150);
  }
  return trimmed || null;
}

/**
 * Persist a compact record of a webhook delivery attempt or update an existing in-flight delivery.
 * Rate-limits writes to protect the database against denial-of-service floods.
 * Guarantees NO payload bodies or secrets are ever stored.
 */
export async function recordWebhookDelivery(input: RecordDeliveryInput): Promise<boolean> {
  const {
    deliveryId,
    eventType,
    action = null,
    repository = null,
    outcome,
    reasonCode,
    error = null,
    createdAt,
  } = input;

  if (!deliveryId || !eventType || !outcome || !reasonCode) {
    logger.warn("[WebhookDeliveryRecorder] Incomplete delivery input skipped", {
      deliveryId,
      eventType,
      outcome,
      reasonCode,
    });
    return false;
  }

  // Rate limit writes to prevent table bloat during flood attacks
  if (!checkWriteRateLimit(outcome)) {
    logger.warn("[WebhookDeliveryRecorder] Delivery write rate limit exceeded. Skipping write.", {
      deliveryId,
      outcome,
      reasonCode,
    });
    return false;
  }

  const cleanError = sanitizeDeliveryError(error);
  const cleanRepo = sanitizeRepository(repository);

  try {
    // If the delivery was already recorded as "queued" and is now completing ("scanned" or "ignored" or "rejected"),
    // update the existing delivery record rather than creating a duplicate row.
    if (outcome !== "queued" && prisma.webhookDelivery?.findFirst) {
      const existing = await prisma.webhookDelivery.findFirst({
        where: { deliveryId },
        orderBy: { createdAt: "desc" },
      });

      if (existing && existing.outcome === "queued") {
        await prisma.webhookDelivery.update({
          where: { id: existing.id },
          data: {
            outcome,
            reasonCode,
            action: action || existing.action,
            repository: cleanRepo || existing.repository,
            error: cleanError || existing.error,
          },
        });
        return true;
      }
    }

    if (prisma.webhookDelivery?.create) {
      await prisma.webhookDelivery.create({
        data: {
          deliveryId,
          eventType,
          action: action || null,
          repository: cleanRepo,
          outcome,
          reasonCode,
          error: cleanError,
          ...(createdAt ? { createdAt } : {}),
        },
      });
    }

    return true;
  } catch (err: any) {
    // Delivery recording must NEVER break the webhook pipeline
    logger.error("[WebhookDeliveryRecorder] Failed to record delivery", {
      deliveryId,
      error: err?.message || String(err),
    });
    return false;
  }
}

/**
 * List recent webhook deliveries within the retention window (default 7 days)
 * with optional filtering by repository, outcome, and reasonCode.
 */
export async function listWebhookDeliveries(options: ListWebhookDeliveriesOptions = {}) {
  const {
    repository,
    outcome,
    reasonCode,
    search,
    limit = 50,
    offset = 0,
    days = WEBHOOK_DELIVERY_RETENTION_DAYS,
    startDate,
  } = options;

  const cutoff = startDate || new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const safeLimit = Math.min(Math.max(limit, 1), 100);

  const where: any = {
    createdAt: { gte: cutoff },
  };

  if (repository && repository.trim() && repository !== "ALL") {
    where.repository = {
      contains: repository.trim(),
      mode: "insensitive",
    };
  }

  if (outcome && outcome.trim() && outcome !== "ALL") {
    where.outcome = outcome.trim().toLowerCase();
  }

  if (reasonCode && reasonCode.trim() && reasonCode !== "ALL") {
    where.reasonCode = reasonCode.trim().toUpperCase();
  }

  if (search && search.trim()) {
    const q = search.trim();
    where.OR = [
      { deliveryId: { contains: q, mode: "insensitive" } },
      { repository: { contains: q, mode: "insensitive" } },
      { eventType: { contains: q, mode: "insensitive" } },
      { reasonCode: { contains: q, mode: "insensitive" } },
      { error: { contains: q, mode: "insensitive" } },
    ];
  }

  if (!prisma.webhookDelivery?.findMany) {
    return { deliveries: [], total: 0, limit: safeLimit, offset };
  }

  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: safeLimit,
      skip: offset,
    }),
    prisma.webhookDelivery.count({ where }),
  ]);

  return {
    deliveries,
    total,
    limit: safeLimit,
    offset,
  };
}

/**
 * Get aggregate statistics of deliveries over the retention window.
 */
export async function getWebhookDeliveryStats(
  days = WEBHOOK_DELIVERY_RETENTION_DAYS,
): Promise<WebhookDeliveryStats> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (!prisma.webhookDelivery?.groupBy) {
    return { total: 0, queued: 0, scanned: 0, ignored: 0, rejected: 0 };
  }

  try {
    const counts = await prisma.webhookDelivery.groupBy({
      by: ["outcome"],
      where: { createdAt: { gte: cutoff } },
      _count: { _all: true },
    });

    const stats: WebhookDeliveryStats = {
      total: 0,
      queued: 0,
      scanned: 0,
      ignored: 0,
      rejected: 0,
    };

    for (const entry of counts) {
      const c = entry._count._all;
      stats.total += c;
      if (entry.outcome === "queued") stats.queued = c;
      else if (entry.outcome === "scanned") stats.scanned = c;
      else if (entry.outcome === "ignored") stats.ignored = c;
      else if (entry.outcome === "rejected") stats.rejected = c;
    }

    return stats;
  } catch {
    return { total: 0, queued: 0, scanned: 0, ignored: 0, rejected: 0 };
  }
}

/**
 * List distinct repository names that appeared in the last 7 days.
 */
export async function getRecentWebhookRepositories(
  days = WEBHOOK_DELIVERY_RETENTION_DAYS,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (!prisma.webhookDelivery?.findMany) {
    return [];
  }

  try {
    const rows = (await prisma.webhookDelivery.findMany({
      where: {
        createdAt: { gte: cutoff },
        repository: { not: null },
      },
      select: { repository: true },
      distinct: ["repository"],
      orderBy: { repository: "asc" },
      take: 100,
    })) as Array<{ repository: string | null }>;

    return rows.map((r) => r.repository).filter((r): r is string => Boolean(r));
  } catch {
    return [];
  }
}

/**
 * Automatically clean up deliveries older than the retention window.
 */
export async function cleanupOldWebhookDeliveries(
  retentionDays = WEBHOOK_DELIVERY_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  if (!prisma.webhookDelivery?.deleteMany) {
    return 0;
  }

  try {
    const result = await prisma.webhookDelivery.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });
    return result.count;
  } catch (err: any) {
    logger.error("[WebhookDeliveryRecorder] Cleanup of old deliveries failed", {
      error: err?.message || String(err),
    });
    return 0;
  }
}
