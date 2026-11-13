import prisma from "@/lib/prisma";
import { AUDIT_LOG_GENESIS_HASH, computeAuditEntryHash } from "./audit-chain";

export interface VerificationResult {
  valid: boolean;
  totalVerified: number;
  brokenEntryId?: string;
  expectedHash?: string;
  actualHash?: string;
  reason?: string;
}

/**
 * Walks the audit log chain from the oldest chained entry to the newest.
 *
 * Rules:
 * 1. Entries without `entryHash` (legacy rows before hash chaining was introduced)
 *    are skipped.
 * 2. The first chained entry must link to AUDIT_LOG_GENESIS_HASH.
 * 3. Each subsequent entry must link to the preceding entry's `entryHash`.
 * 4. Each entry's `entryHash` must equal `computeAuditEntryHash(...)` recalculated
 *    from its current stored columns.
 *
 * Any alteration or deletion of a chained entry breaks the chain and reports the first broken link.
 */
export async function verifyAuditChain(dbClient: any = prisma): Promise<VerificationResult> {
  const chainedRows = await dbClient.auditLog.findMany({
    where: { entryHash: { not: null } },
    orderBy: [{ timestamp: "asc" }, { id: "asc" }],
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
      reason: "No chained audit log entries found to verify.",
    };
  }

  let expectedPreviousHash = AUDIT_LOG_GENESIS_HASH;

  for (let i = 0; i < chainedRows.length; i++) {
    const row = chainedRows[i];

    // Check link to prior entry
    if (row.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        totalVerified: i,
        brokenEntryId: row.id,
        expectedHash: expectedPreviousHash,
        actualHash: row.previousHash ?? undefined,
        reason: `Broken chain link at entry ${row.id}: previousHash does not match preceding entryHash (expected ${expectedPreviousHash}, got ${row.previousHash})`,
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
        expectedHash: recomputedHash,
        actualHash: row.entryHash ?? undefined,
        reason: `Tampered entry detected at ${row.id}: entryHash mismatch (expected ${recomputedHash}, got ${row.entryHash})`,
      };
    }

    expectedPreviousHash = row.entryHash;
  }

  return {
    valid: true,
    totalVerified: chainedRows.length,
  };
}
