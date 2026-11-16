import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadThreatFeedDatasetMock, syncThreatFeedsMock, syncCisaKevCatalogMock } = vi.hoisted(
  () => ({
    loadThreatFeedDatasetMock: vi.fn(),
    syncThreatFeedsMock: vi.fn(),
    syncCisaKevCatalogMock: vi.fn(),
  }),
);

vi.mock("../src/lib/security/threat-feed", () => ({
  DEFAULT_FEED_PATH: "/mock/default/threat-feed.json",
  DEFAULT_THREAT_FEED_SOURCES: [
    { name: "Source 1", url: "https://example.com/feed1", enabled: true },
    { name: "Source 2", url: "https://example.com/feed2", enabled: false },
  ],
  loadThreatFeedDataset: loadThreatFeedDatasetMock,
  syncThreatFeeds: syncThreatFeedsMock,
}));

vi.mock("../cli/src/threat-intel-feed", () => ({
  syncCisaKevCatalog: syncCisaKevCatalogMock,
}));

import { syncThreatFeedMain } from "./sync-threat-feed";

describe("scripts/sync-threat-feed.ts (#1330)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadThreatFeedDatasetMock.mockReturnValue({ payloads: [{ id: "p1" }, { id: "p2" }] });
    syncCisaKevCatalogMock.mockResolvedValue({
      catalogVersion: "test",
      totalVulnerabilities: 10,
      newlyAdded: 2,
      dateReleased: "2026-11-11T00:00:00.000Z",
    });
    syncThreatFeedsMock.mockResolvedValue({
      success: true,
      totalPayloads: 5,
      newPayloadsAdded: 3,
      sourcesSynced: ["Source 1"],
      errors: [],
      categoryCounts: {
        ROLE_PLAY_JAILBREAK: 3,
        PROMPT_LEAKAGE: 2,
      },
    });
  });

  it("supports CISA KEV synchronization in dry-run mode", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "scripts/sync-threat-feed.ts", "--kev", "--dry-run", "--quiet"];

    try {
      const exitCode = await syncThreatFeedMain();

      expect(exitCode).toBe(0);
      expect(syncCisaKevCatalogMock).toHaveBeenCalledWith({ dryRun: true });
      expect(syncThreatFeedsMock).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("executes threat feed synchronization in default mode", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "scripts/sync-threat-feed.ts", "--quiet"];

    const exitCode = await syncThreatFeedMain();
    expect(exitCode).toBe(0);

    expect(loadThreatFeedDatasetMock).toHaveBeenCalledWith("/mock/default/threat-feed.json");
    expect(syncThreatFeedsMock).toHaveBeenCalledWith({
      outputPath: "/mock/default/threat-feed.json",
      sources: expect.any(Array),
    });

    process.argv = originalArgv;
  });

  it("supports --dry-run mode without mutating production dataset path", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "scripts/sync-threat-feed.ts", "--dry-run", "--quiet"];

    const exitCode = await syncThreatFeedMain();
    expect(exitCode).toBe(0);

    expect(syncThreatFeedsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        // Dry runs write to the OS temp dir, never the repo root.
        outputPath: expect.stringMatching(/secureflow-dry-run-feed-.*\.json$/),
      }),
    );
    const calledPath = syncThreatFeedsMock.mock.calls[0][0].outputPath;
    expect(path.isAbsolute(calledPath)).toBe(true);
    expect(calledPath.startsWith(process.cwd())).toBe(false);

    process.argv = originalArgv;
  });

  it("handles custom output path passed via --out", async () => {
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "scripts/sync-threat-feed.ts",
      "--out",
      "custom-output.json",
      "--quiet",
    ];

    const exitCode = await syncThreatFeedMain();
    expect(exitCode).toBe(0);

    expect(syncThreatFeedsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: expect.stringContaining("custom-output.json"),
      }),
    );

    process.argv = originalArgv;
  });

  it("reports warnings and errors when upstream feed fetch encounters issues", async () => {
    syncThreatFeedsMock.mockResolvedValueOnce({
      success: false,
      totalPayloads: 2,
      newPayloadsAdded: 0,
      sourcesSynced: [],
      errors: ["HTTP 503 from external feed provider"],
      categoryCounts: {},
    });

    const originalArgv = process.argv;
    process.argv = ["node", "scripts/sync-threat-feed.ts", "--quiet"];

    const exitCode = await syncThreatFeedMain();
    expect(exitCode).toBe(0);

    process.argv = originalArgv;
  });
});
