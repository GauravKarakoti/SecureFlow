import { describe, expect, it } from "vitest";
import { countDistinctFindings } from "./finding-counts";

interface Row {
  fingerprint: string;
  type: string;
  severity: string;
  userId: string;
}

/**
 * An in-memory `finding` table that evaluates the subset of Prisma's `where`
 * these helpers build, so the tests assert on counts rather than on the shape
 * of the query.
 */
function fakeDb(rows: Row[]) {
  const matches = (row: Row, where: any): boolean => {
    if (where.type && row.type !== where.type) return false;
    if (where.severity && row.severity !== where.severity) return false;
    const owner = where.scanResult?.pullRequest?.repository?.userId;
    if (owner && row.userId !== owner) return false;
    const fp = where.fingerprint;
    if (typeof fp === "string" && row.fingerprint !== fp) return false;
    if (fp?.notIn && fp.notIn.includes(row.fingerprint)) return false;
    return true;
  };

  return {
    finding: {
      groupBy: async ({ where }: { where: any }) =>
        [...new Set(rows.filter((r) => matches(r, where)).map((r) => r.fingerprint))].map(
          (fingerprint) => ({ fingerprint }),
        ),
      count: async ({ where }: { where: any }) => rows.filter((r) => matches(r, where)).length,
    },
  };
}

/** The dashboard's call: the user's findings, minus dismissed fingerprints. */
const overview = async (db: ReturnType<typeof fakeDb>, userId: string, suppressed: string[]) => {
  const count = (where: Record<string, unknown>) =>
    countDistinctFindings(
      db,
      { scanResult: { pullRequest: { repository: { userId } } }, ...where },
      suppressed,
    );
  const [secretsDetected, critical, high, medium, low] = await Promise.all([
    count({ type: "SECRET" }),
    count({ severity: "CRITICAL" }),
    count({ severity: "HIGH" }),
    count({ severity: "MEDIUM" }),
    count({ severity: "LOW" }),
  ]);
  return { secretsDetected, distribution: { critical, high, medium, low } };
};

/** The same finding, re-stored by `n` scans of its pull request. */
const rescanned = (n: number, row: Omit<Row, "userId">): Row[] =>
  Array.from({ length: n }, () => ({ ...row, userId: "u1" }));

describe("dashboard finding counts", () => {
  it("counts a finding once however many times its PR was rescanned", async () => {
    // One hardcoded secret, pushed five times: the dashboard used to say 5.
    const db = fakeDb(
      rescanned(5, { fingerprint: "fp-secret", type: "SECRET", severity: "CRITICAL" }),
    );

    const counts = await overview(db, "u1", []);

    expect(counts.secretsDetected).toBe(1);
    expect(counts.distribution).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
  });

  it("counts distinct findings in each severity bucket", async () => {
    const db = fakeDb([
      ...rescanned(3, { fingerprint: "a", type: "SECRET", severity: "HIGH" }),
      ...rescanned(2, { fingerprint: "b", type: "VULNERABILITY", severity: "HIGH" }),
      ...rescanned(4, { fingerprint: "c", type: "MISCONFIG", severity: "LOW" }),
    ]);

    const counts = await overview(db, "u1", []);

    expect(counts.secretsDetected).toBe(1);
    expect(counts.distribution).toEqual({ critical: 0, high: 2, medium: 0, low: 1 });
  });

  it("still excludes dismissed findings", async () => {
    const db = fakeDb([
      ...rescanned(2, { fingerprint: "kept", type: "SECRET", severity: "HIGH" }),
      ...rescanned(2, { fingerprint: "dismissed", type: "SECRET", severity: "HIGH" }),
    ]);

    const counts = await overview(db, "u1", ["dismissed"]);

    expect(counts.secretsDetected).toBe(1);
    expect(counts.distribution.high).toBe(1);
  });

  it("only counts the user's own findings", async () => {
    const db = fakeDb([
      { fingerprint: "mine", type: "SECRET", severity: "HIGH", userId: "u1" },
      { fingerprint: "theirs", type: "SECRET", severity: "HIGH", userId: "u2" },
    ]);

    expect((await overview(db, "u1", [])).secretsDetected).toBe(1);
  });
});

describe("countDistinctFindings", () => {
  it("counts unfingerprinted rows individually, since they cannot be de-duplicated", async () => {
    const db = fakeDb([
      ...rescanned(3, { fingerprint: "", type: "SECRET", severity: "HIGH" }),
      ...rescanned(2, { fingerprint: "fp", type: "SECRET", severity: "HIGH" }),
    ]);

    expect(await countDistinctFindings(db, { type: "SECRET" })).toBe(4);
  });
});
