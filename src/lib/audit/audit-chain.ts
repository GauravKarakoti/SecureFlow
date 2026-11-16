import crypto from "crypto";
import prisma from "@/lib/prisma";

/**
 * Genesis hash for the start of the chained AuditLog.
 * SHA-256 digest of 'SECUREFLOW_AUDIT_LOG_GENESIS'.
 */
export const AUDIT_LOG_GENESIS_HASH = crypto
  .createHash("sha256")
  .update("SECUREFLOW_AUDIT_LOG_GENESIS")
  .digest("hex");

/**
 * Parameters required to compute an entry's cryptographic hash.
 */
export interface AuditEntryHashInput {
  previousHash: string;
  timestamp: Date | string;
  action: string;
  resource?: string | null;
  decision?: string | null;
  userId?: string | null;
  metadata?: unknown;
}

/**
 * Deterministically sorts object keys for canonical JSON serialization.
 */
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalizeJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Computes a deterministic SHA-256 entry hash for an AuditLog row.
 * Covers previousHash, timestamp (ISO), action, resource, decision, userId, and metadata.
 */
export function computeAuditEntryHash(input: AuditEntryHashInput): string {
  const ts =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : new Date(input.timestamp).toISOString();
  const parts = [
    input.previousHash,
    ts,
    input.action,
    input.resource ?? "",
    input.decision ?? "",
    input.userId ?? "",
    canonicalizeJson(input.metadata ?? null),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Input fields for writing a chained audit log entry.
 */
export interface WriteAuditLogData {
  userId?: string | null;
  action: string;
  resource?: string | null;
  decision?: string | null;
  metadata?: unknown;
  timestamp?: Date;
}

/**
 * Postgres advisory lock ID for serializing audit log chain writes.
 * Chosen as a 64-bit bigint hash: "audit_log_chain_lock" -> 0x41554449544c4f47 (4707736636746829639n).
 */
const AUDIT_CHAIN_LOCK_KEY = "4707736636746829639";

/**
 * Writes an audit log entry inside a transaction, locking concurrency and
 * chaining from the latest existing entryHash (or AUDIT_LOG_GENESIS_HASH).
 *
 * If passed an existing transaction context `tx`, executes inside that `tx`.
 * Otherwise, wraps the write in `prisma.$transaction`.
 */
export async function writeChainedAuditLog(dbOrTx: any, data: WriteAuditLogData) {
  const executeInTx = async (tx: any) => {
    // Acquire transaction-scoped advisory lock if PostgreSQL supports it
    try {
      if (typeof tx.$executeRawUnsafe === "function") {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);
      }
    } catch {
      // In SQLite, unit-test in-memory mocks, or environments without pg_advisory_xact_lock, ignore
    }

    // Find the latest chained entry to link against
    const lastChained = await tx.auditLog.findFirst({
      where: { entryHash: { not: null } },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: { id: true, entryHash: true },
    });

    const previousHash = lastChained?.entryHash || AUDIT_LOG_GENESIS_HASH;
    const timestamp = data.timestamp ?? new Date();

    const entryHash = computeAuditEntryHash({
      previousHash,
      timestamp,
      action: data.action,
      resource: data.resource,
      decision: data.decision,
      userId: data.userId,
      metadata: data.metadata,
    });

    return await tx.auditLog.create({
      data: {
        userId: data.userId ?? null,
        action: data.action,
        resource: data.resource ?? "",
        decision: data.decision ?? null,
        metadata: data.metadata as any,
        timestamp,
        previousHash,
        entryHash,
      },
    });
  };

  // If dbOrTx has $transaction, use it to start a new transaction
  if (typeof dbOrTx?.$transaction === "function") {
    return await dbOrTx.$transaction(async (tx: any) => executeInTx(tx));
  }

  // Otherwise, assume dbOrTx is already a transaction client or direct client
  return await executeInTx(dbOrTx || prisma);
}
