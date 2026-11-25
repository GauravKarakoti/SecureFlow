import { describe, it, expect } from "vitest";
import { diffSbomSnapshots } from "./sbom-diff";
import { PERMISSIVE_ONLY_POLICY } from "./spdx-license-policy";
import { compareScans } from "@/lib/scans/comparison";
import type { Dependency } from "@/types/sbom";

describe("Deterministic SBOM Snapshot Diffing & Supply-Chain Drift (#2110)", () => {
  it("classifies added, removed, upgraded, downgraded, and unchanged dependencies", () => {
    const base: Dependency[] = [
      { name: "lodash", version: "4.17.20", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "axios", version: "1.6.0", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "moment", version: "2.29.4", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "serde", version: "1.0.197", manifestFile: "Cargo.lock", ecosystem: "cargo" },
    ];

    const head: Dependency[] = [
      { name: "lodash", version: "4.17.21", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "axios", version: "1.4.0", manifestFile: "package-lock.json", ecosystem: "npm" },
      { name: "serde", version: "1.0.197", manifestFile: "Cargo.lock", ecosystem: "cargo" },
      { name: "golang.org/x/crypto", version: "0.21.0", manifestFile: "go.sum", ecosystem: "go" },
    ];

    const diff = diffSbomSnapshots(base, head);
    expect(diff.summary).toEqual({
      totalBase: 4,
      totalHead: 4,
      addedCount: 1,
      removedCount: 1,
      upgradedCount: 1,
      downgradedCount: 1,
      unchangedCount: 1,
      licenseRegressionCount: 0,
    });

    expect(diff.added[0]?.name).toBe("golang.org/x/crypto");
    expect(diff.removed[0]?.name).toBe("moment");
    expect(diff.upgraded[0]).toMatchObject({
      name: "lodash",
      baseVersion: "4.17.20",
      headVersion: "4.17.21",
    });
    expect(diff.downgraded[0]).toMatchObject({
      name: "axios",
      baseVersion: "1.6.0",
      headVersion: "1.4.0",
    });
    expect(diff.unchanged[0]?.name).toBe("serde");
  });

  it("detects license compliance regressions on upgrades and newly added dependencies", () => {
    const base: Dependency[] = [
      {
        name: "pkg-a",
        version: "1.0.0",
        manifestFile: "bom.json",
        ecosystem: "npm",
        license: "MIT",
      },
      {
        name: "pkg-already-bad",
        version: "1.0.0",
        manifestFile: "bom.json",
        ecosystem: "npm",
        license: "GPL-3.0-only",
      },
    ];

    const head: Dependency[] = [
      {
        name: "pkg-a",
        version: "2.0.0",
        manifestFile: "bom.json",
        ecosystem: "npm",
        license: "GPL-3.0-only",
      },
      {
        name: "pkg-already-bad",
        version: "1.1.0",
        manifestFile: "bom.json",
        ecosystem: "npm",
        license: "GPL-3.0-only",
      },
      {
        name: "pkg-new-copyleft",
        version: "0.5.0",
        manifestFile: "bom.json",
        ecosystem: "npm",
        license: "AGPL-3.0-only",
      },
    ];

    const diff = diffSbomSnapshots(base, head, PERMISSIVE_ONLY_POLICY);
    expect(diff.summary.licenseRegressionCount).toBe(2);
    expect(diff.licenseRegressions.map((r) => r.name).sort()).toEqual([
      "pkg-a",
      "pkg-new-copyleft",
    ]);
    expect(diff.licenseRegressions.find((r) => r.name === "pkg-a")?.previousLicense).toBe("MIT");
  });

  it("handles empty snapshots cleanly", () => {
    const empty = diffSbomSnapshots([], []);
    expect(empty.summary).toEqual({
      totalBase: 0,
      totalHead: 0,
      addedCount: 0,
      removedCount: 0,
      upgradedCount: 0,
      downgradedCount: 0,
      unchangedCount: 0,
      licenseRegressionCount: 0,
    });
  });

  it("integrates with compareScans in src/lib/scans/comparison.ts", () => {
    const res = compareScans(
      {
        id: "scan-base",
        createdAt: new Date("2026-11-24T00:00:00Z"),
        findings: [],
        dependencies: [
          {
            name: "express",
            version: "4.18.2",
            manifestFile: "package-lock.json",
            ecosystem: "npm",
          },
        ],
      },
      {
        id: "scan-target",
        createdAt: new Date("2026-11-25T00:00:00Z"),
        findings: [],
        dependencies: [
          {
            name: "express",
            version: "4.19.2",
            manifestFile: "package-lock.json",
            ecosystem: "npm",
          },
          {
            name: "gpl-lib",
            version: "1.0.0",
            manifestFile: "bom.json",
            ecosystem: "npm",
            license: "GPL-3.0-only",
          },
        ],
      },
    );

    expect(res.isComparable).toBe(true);
    expect(res.sbomDiff).toBeDefined();
    expect(res.sbomDiff?.summary.upgradedCount).toBe(1);
    expect(res.sbomDiff?.summary.addedCount).toBe(1);
    expect(res.sbomDiff?.summary.licenseRegressionCount).toBe(1);
  });
});
