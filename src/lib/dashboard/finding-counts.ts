/**
 * Finding counts for the overview dashboard, counted once per finding rather
 * than once per scan.
 *
 * The webhook worker writes a new `ScanResult` — with a full copy of its
 * findings — every time a pull request is pushed to. The dashboard counted
 * `Finding` rows, so one hardcoded secret in a PR that was pushed five times
 * read as five "Secrets Detected", and the severity distribution grew with
 * every rescan of an unchanged PR. The leaderboard avoids the same trap by
 * reading only the newest scan per PR; that does not work here, because SBOM
 * scans write their own `ScanResult` rows on the same pull request.
 *
 * A finding's fingerprint is stable across rescans (`computeFingerprint`:
 * repository, file, type and snippet), so these count distinct fingerprints.
 * Rows without one (the column's `""` default, from before fingerprints were
 * written) cannot be de-duplicated and are counted individually, as before.
 */

type Where = Record<string, unknown>;

export interface FindingCountClient {
  finding: {
    groupBy: (args: {
      by: ["fingerprint"];
      where: Where;
      _count?: { _all: true };
    }) => Promise<Array<{ fingerprint: string }>>;
    count: (args: { where: Where }) => Promise<number>;
  };
}

/** Distinct findings matching `where`: one per fingerprint, plus every unfingerprinted row. */
export async function countDistinctFindings(
  db: FindingCountClient,
  where: Where,
  excludedFingerprints: readonly string[] = [],
): Promise<number> {
  const [groups, unfingerprinted] = await Promise.all([
    db.finding.groupBy({
      by: ["fingerprint"],
      where: { ...where, fingerprint: { notIn: [...excludedFingerprints, ""] } },
    }),
    db.finding.count({ where: { ...where, fingerprint: "" } }),
  ]);

  return groups.length + unfingerprinted;
}
