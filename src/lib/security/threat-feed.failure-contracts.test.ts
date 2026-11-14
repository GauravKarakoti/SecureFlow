import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchFeedFromSource,
  loadThreatFeedDataset,
  parseFeedContent,
  syncThreatFeeds,
  type ThreatFeedSource,
} from "./threat-feed";

const source: ThreatFeedSource = {
  name: "SyntheticFixture",
  url: "https://feeds.example.invalid/fixture",
  format: "json-array",
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("external threat-feed failure contracts", () => {
  it("filters line-delimited comments/fences and deduplicates usable records", () => {
    const rows = parseFeedContent(
      "# ignored comment fixture\n```ignored fence fixture\nshort\n synthetic fixture record \nSYNTHETIC   FIXTURE RECORD\nsecond synthetic record",
      { ...source, format: "line-delimited", defaultCategory: "indirect-injection" },
    );
    expect(rows.map((r) => r.payload)).toEqual([
      "synthetic fixture record",
      "second synthetic record",
    ]);
    expect(rows.every((r) => r.category === "indirect-injection" && r.source === source.name)).toBe(
      true,
    );
    expect(
      parseFeedContent("another synthetic record", { ...source, format: "line-delimited" }),
    ).toHaveLength(1);
  });

  it("accepts supported JSON record aliases while ignoring null, numeric and unusable entries", () => {
    const rows = parseFeedContent(
      JSON.stringify([
        null,
        17,
        { payload: 12 },
        { prompt: "prompt fixture record", category: "fixture description" },
        { jailbreak: "jailbreak fixture record", name: "named fixture" },
        { text: "text fixture record" },
        { attack: "attack fixture record", description: "described fixture" },
      ]),
      source,
    );
    expect(rows.map((r) => r.payload)).toEqual([
      "prompt fixture record",
      "jailbreak fixture record",
      "text fixture record",
      "attack fixture record",
    ]);
    expect(rows[0].description).toBe("fixture description");
    expect(rows[1].description).toBe("named fixture");
  });

  it.each(["json-array", "threat-feed-json", "csv"] as const)(
    "returns no records for unsupported %s shapes",
    (format) => {
      expect(parseFeedContent("{}", { ...source, format })).toEqual([]);
    },
  );

  it("treats an invalid local dataset as empty rather than admitting arbitrary objects", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue('{"payloads":{}}');
    expect(loadThreatFeedDataset("synthetic-cache.json").payloads).toEqual([]);
    read.mockReturnValue("{invalid-json");
    expect(loadThreatFeedDataset("synthetic-cache.json").payloads).toEqual([]);
    read.mockImplementation(() => {
      throw new Error("synthetic read failure");
    });
    expect(loadThreatFeedDataset("synthetic-cache.json").payloads).toEqual([]);
  });

  it("contains non-Error network rejections without making a real network request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue("synthetic network rejection");
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFeedFromSource(source)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips disabled sources, preserves existing records, and reports persistence failure", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        version: "",
        sources: [],
        payloads: [
          {
            id: "existing",
            payload: "synthetic fixture record",
            category: "indirect-injection",
            source: "existing",
            description: "existing record",
          },
        ],
      }),
    );
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("synthetic disk full");
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify(["synthetic fixture record", "new synthetic fixture record"]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncThreatFeeds({
      sources: [{ ...source, enabled: false }, source],
      outputPath: "synthetic-cache.json",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      newPayloadsAdded: 1,
      totalPayloads: 2,
      sourcesSynced: [source.name],
    });
    expect(result.errors).toEqual([expect.stringContaining("synthetic disk full")]);
    const written = JSON.parse(String(write.mock.calls[0][1]));
    expect(written.version).toBe("1.0.0");
    expect(written.payloads.map((r: { payload: string }) => r.payload)).toEqual([
      "synthetic fixture record",
      "new synthetic fixture record",
    ]);
  });
});
