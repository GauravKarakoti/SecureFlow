import prisma from "@/lib/prisma";
import { AUDIT_LOG_GENESIS_HASH, computeAuditEntryHash } from "./audit-chain";
import {
  decodeCursor,
  encodeCursor,
  parseLimit,
  DEFAULT_PAGE_LIMIT,
} from "@/lib/pagination/cursor";
import {
  createPortableAuditProofBundle,
  verifyPortableAuditProofBundle,
  type AuditProofEventInput,
  type PortableAuditProofBundle,
} from "./merkle-proof";

export interface VerificationResult {
  valid: boolean;
  totalVerified: number;
  brokenEntryId?: string;
  firstInvalidEntryId?: string;
  expectedHash?: string;
  actualHash?: string;
  reason?: string;
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface VerifyAuditChainOptions {
  cursor?: string | null;
  limit?: number;
  dbClient?: any;
}

/**
 * Walks the audit log chain from the oldest chained entry to the newest.
 * Supports cursor-based batch verification for bounded execution and memory safety.
 *
 * Rules:
 * 1. Entries without `entryHash` (legacy rows before hash chaining was introduced)
 *    are skipped.
 * 2. The first chained entry must link to AUDIT_LOG_GENESIS_HASH (or to the cursor entry's entryHash).
 * 3. Each subsequent entry must link to the preceding entry's `entryHash`.
 * 4. Each entry's `entryHash` must equal `computeAuditEntryHash(...)` recalculated
 *    from its current stored columns.
 *
 * Any alteration or deletion of a chained entry breaks the chain and reports the broken link pinpointing details.
 */
export async function verifyAuditChain(
  dbClientOrOptions: any = prisma,
  maybeOptions?: VerifyAuditChainOptions,
): Promise<VerificationResult> {
  let dbClient = prisma;
  let options: VerifyAuditChainOptions = {};

  if (
    dbClientOrOptions &&
    (dbClientOrOptions.cursor !== undefined ||
      dbClientOrOptions.limit !== undefined ||
      dbClientOrOptions.dbClient !== undefined)
  ) {
    options = dbClientOrOptions;
    dbClient = dbClientOrOptions.dbClient || prisma;
  } else if (maybeOptions) {
    dbClient = dbClientOrOptions || prisma;
    options = maybeOptions;
  } else if (dbClientOrOptions && typeof dbClientOrOptions.auditLog?.findMany === "function") {
    dbClient = dbClientOrOptions;
  }

  const limit = parseLimit(options.limit, DEFAULT_PAGE_LIMIT, 500);
  const decodedCursor = decodeCursor(options.cursor);

  let expectedPreviousHash = AUDIT_LOG_GENESIS_HASH;

  if (decodedCursor) {
    const cursorRow = await dbClient.auditLog.findUnique({
      where: { id: decodedCursor.id },
      select: { id: true, entryHash: true },
    });
    if (cursorRow?.entryHash) {
      expectedPreviousHash = cursorRow.entryHash;
    }
  }

  const whereCondition: any = { entryHash: { not: null } };
  if (decodedCursor) {
    whereCondition.OR = [
      { timestamp: { gt: decodedCursor.createdAt } },
      {
        AND: [{ timestamp: decodedCursor.createdAt }, { id: { gt: decodedCursor.id } }],
      },
    ];
  }

  // Fetch limit + 1 to detect hasMore and produce nextCursor
  const chainedRows = await dbClient.auditLog.findMany({
    where: whereCondition,
    orderBy: [{ timestamp: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      action: true,
      resource: true,
      decision: true,
      metadata: true,
      timestamp: true,
      previousHash: true,
      entryHash: true,
    },
  });

  if (!chainedRows || chainedRows.length === 0) {
    return {
      valid: true,
      totalVerified: 0,
      nextCursor: null,
      hasMore: false,
      reason: "No chained audit log entries found to verify.",
    };
  }

  const hasMore = chainedRows.length > limit;
  const rowsToVerify = hasMore ? chainedRows.slice(0, limit) : chainedRows;

  for (let i = 0; i < rowsToVerify.length; i++) {
    const row = rowsToVerify[i];

    // Check link to prior entry
    if (row.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        totalVerified: i,
        brokenEntryId: row.id,
        firstInvalidEntryId: row.id,
        expectedHash: expectedPreviousHash,
        actualHash: row.previousHash ?? undefined,
        reason: `Broken chain link at entry ${row.id}: previousHash does not match preceding entryHash (expected ${expectedPreviousHash}, got ${row.previousHash})`,
        nextCursor: null,
        hasMore: false,
      };
    }

    // Verify row content tamper-evidence
    const recomputedHash = computeAuditEntryHash({
      previousHash: row.previousHash,
      timestamp: row.timestamp,
      action: row.action,
      resource: row.resource,
      decision: row.decision,
      userId: row.userId,
      metadata: row.metadata,
    });

    if (recomputedHash !== row.entryHash) {
      return {
        valid: false,
        totalVerified: i,
        brokenEntryId: row.id,
        firstInvalidEntryId: row.id,
        expectedHash: recomputedHash,
        actualHash: row.entryHash ?? undefined,
        reason: `Tampered entry detected at ${row.id}: entryHash mismatch (expected ${recomputedHash}, got ${row.entryHash})`,
        nextCursor: null,
        hasMore: false,
      };
    }

    expectedPreviousHash = row.entryHash;
  }

  const lastVerifiedRow = rowsToVerify[rowsToVerify.length - 1];
  const nextCursor = hasMore && lastVerifiedRow ? encodeCursor(lastVerifiedRow) : null;

  return {
    valid: true,
    totalVerified: rowsToVerify.length,
    nextCursor,
    hasMore,
  };
}

/**
 * Export a portable Merkle inclusion proof bundle for a verified audit event.
 */
export function exportAuditEventMerkleProof(
  events: readonly AuditProofEventInput[],
  targetEventId: string,
): PortableAuditProofBundle {
  return createPortableAuditProofBundle(events, targetEventId);
}

/**
 * Offline verification wrapper for a portable Merkle inclusion proof bundle.
 */
export function verifyAuditEventMerkleProof(bundle: PortableAuditProofBundle) {
  return verifyPortableAuditProofBundle(bundle);
}
