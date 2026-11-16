import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_LOG_GENESIS_HASH, computeAuditEntryHash, writeChainedAuditLog } from "./audit-chain";
import { verifyAuditChain } from "./verify-chain";

describe("Tamper-Evident Audit Log Hash Chain", () => {
  let mockDb: any;
  let storedLogs: any[];

  beforeEach(() => {
    storedLogs = [];

    mockDb = {
      auditLog: {
        findFirst: vi.fn(async ({ where, orderBy }: any) => {
          let rows = [...storedLogs];
          if (where?.entryHash?.not === null) {
            rows = rows.filter((r) => r.entryHash != null);
          }
          if (orderBy) {
            rows.sort((a, b) => {
              const diff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
              return diff !== 0 ? diff : b.id.localeCompare(a.id);
            });
          }
          return rows[0] || null;
        }),
        findMany: vi.fn(async ({ where, orderBy }: any) => {
          let rows = [...storedLogs];
          if (where?.entryHash?.not === null) {
            rows = rows.filter((r) => r.entryHash != null);
          }
          if (orderBy) {
            rows.sort((a, b) => {
              const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
              return diff !== 0 ? diff : a.id.localeCompare(b.id);
            });
          }
          return rows;
        }),
        create: vi.fn(async ({ data }: any) => {
          const newRow = {
            id: `audit-${storedLogs.length + 1}`,
            ...data,
          };
          storedLogs.push(newRow);
          return newRow;
        }),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
        return await cb(mockDb);
      }),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
  });

  it("calculates deterministic hash regardless of metadata key ordering", () => {
    const timestamp = new Date("2026-11-13T12:00:00.000Z");
    const hash1 = computeAuditEntryHash({
      previousHash: AUDIT_LOG_GENESIS_HASH,
      timestamp,
      action: "POLICY_EVALUATION",
      resource: "repo#1",
      decision: "PASS",
      userId: "user-1",
      metadata: { a: 1, b: 2, c: { x: "foo", y: "bar" } },
    });

    const hash2 = computeAuditEntryHash({
      previousHash: AUDIT_LOG_GENESIS_HASH,
      timestamp,
      action: "POLICY_EVALUATION",
      resource: "repo#1",
      decision: "PASS",
      userId: "user-1",
      metadata: { c: { y: "bar", x: "foo" }, b: 2, a: 1 },
    });

    expect(hash1).toBe(hash2);
  });

  it("starts a new chain from the documented genesis entry for the first chained row", async () => {
    // Add an unchained legacy row first
    storedLogs.push({
      id: "legacy-1",
      userId: "user-legacy",
      action: "LEGACY_EVENT",
      resource: "old-repo",
      decision: "PASS",
      metadata: null,
      timestamp: new Date("2025-01-01T00:00:00.000Z"),
      previousHash: null,
      entryHash: null,
    });

    const entry = await writeChainedAuditLog(mockDb, {
      userId: "user-1",
      action: "ADMIN_LOGIN",
      resource: "system",
      decision: "SUCCESS",
      timestamp: new Date("2026-11-13T10:00:00.000Z"),
    });

    expect(entry.previousHash).toBe(AUDIT_LOG_GENESIS_HASH);
    expect(entry.entryHash).toBeDefined();

    const verification = await verifyAuditChain(mockDb);
    expect(verification.valid).toBe(true);
    expect(verification.totalVerified).toBe(1);
  });

  it("links consecutive rows sequentially and validates correctly", async () => {
    const baseTime = 1700000000000;
    for (let i = 1; i <= 5; i++) {
      await writeChainedAuditLog(mockDb, {
        userId: `user-${i}`,
        action: `ACTION_${i}`,
        resource: `resource-${i}`,
        decision: "PASS",
        timestamp: new Date(baseTime + i * 1000),
      });
    }

    expect(storedLogs).toHaveLength(5);
    expect(storedLogs[0].previousHash).toBe(AUDIT_LOG_GENESIS_HASH);
    expect(storedLogs[1].previousHash).toBe(storedLogs[0].entryHash);
    expect(storedLogs[2].previousHash).toBe(storedLogs[1].entryHash);
    expect(storedLogs[3].previousHash).toBe(storedLogs[2].entryHash);
    expect(storedLogs[4].previousHash).toBe(storedLogs[3].entryHash);

    const verification = await verifyAuditChain(mockDb);
    expect(verification.valid).toBe(true);
    expect(verification.totalVerified).toBe(5);
  });

  it("fails verification and identifies the entry when a stored row is modified", async () => {
    const baseTime = 1700000000000;
    for (let i = 1; i <= 4; i++) {
      await writeChainedAuditLog(mockDb, {
        userId: `user-${i}`,
        action: `ACTION_${i}`,
        resource: `resource-${i}`,
        decision: "PASS",
        timestamp: new Date(baseTime + i * 1000),
      });
    }

    // Tamper with the 3rd entry in the database (e.g. change decision from PASS to BLOCK)
    storedLogs[2].decision = "BLOCK";

    const verification = await verifyAuditChain(mockDb);
    expect(verification.valid).toBe(false);
    expect(verification.brokenEntryId).toBe(storedLogs[2].id);
    expect(verification.reason).toContain("Tampered entry detected at audit-3");
    expect(verification.totalVerified).toBe(2);
  });

  it("fails verification and identifies the entry when a stored row is deleted", async () => {
    const baseTime = 1700000000000;
    for (let i = 1; i <= 4; i++) {
      await writeChainedAuditLog(mockDb, {
        userId: `user-${i}`,
        action: `ACTION_${i}`,
        resource: `resource-${i}`,
        decision: "PASS",
        timestamp: new Date(baseTime + i * 1000),
      });
    }

    const deletedId = storedLogs[1].id;
    // Delete the 2nd row (audit-2)
    storedLogs.splice(1, 1);

    const verification = await verifyAuditChain(mockDb);
    expect(verification.valid).toBe(false);
    // Row 3 (now at index 1) will point to deleted row 2's hash, which doesn't match row 1's entryHash
    expect(verification.brokenEntryId).toBe("audit-3");
    expect(verification.reason).toContain("Broken chain link at entry audit-3");
  });

  it("handles concurrent writes sequentially without breaking the chain", async () => {
    let lockAcquired = false;
    const lockWaitQueue: Array<() => void> = [];

    mockDb.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
      // Simulate transaction serialization with mutex/advisory lock
      await new Promise<void>((resolve) => {
        if (!lockAcquired) {
          lockAcquired = true;
          resolve();
        } else {
          lockWaitQueue.push(resolve);
        }
      });

      try {
        return await cb(mockDb);
      } finally {
        if (lockWaitQueue.length > 0) {
          const next = lockWaitQueue.shift();
          next?.();
        } else {
          lockAcquired = false;
        }
      }
    });

    const baseTime = 1700000000000;
    // Fire 5 writes concurrently
    await Promise.all([
      writeChainedAuditLog(mockDb, {
        action: "EVENT_1",
        resource: "res_1",
        timestamp: new Date(baseTime + 1000),
      }),
      writeChainedAuditLog(mockDb, {
        action: "EVENT_2",
        resource: "res_2",
        timestamp: new Date(baseTime + 2000),
      }),
      writeChainedAuditLog(mockDb, {
        action: "EVENT_3",
        resource: "res_3",
        timestamp: new Date(baseTime + 3000),
      }),
      writeChainedAuditLog(mockDb, {
        action: "EVENT_4",
        resource: "res_4",
        timestamp: new Date(baseTime + 4000),
      }),
      writeChainedAuditLog(mockDb, {
        action: "EVENT_5",
        resource: "res_5",
        timestamp: new Date(baseTime + 5000),
      }),
    ]);

    expect(storedLogs).toHaveLength(5);
    const verification = await verifyAuditChain(mockDb);
    expect(verification.valid).toBe(true);
    expect(verification.totalVerified).toBe(5);
  });
});
