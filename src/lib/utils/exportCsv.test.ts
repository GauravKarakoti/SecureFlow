/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadCSV, downloadJSON } from "./exportCsv";
import { CSV_BOM, CSV_ROW_SEPARATOR } from "./csv";

/**
 * jsdom implements neither `URL.createObjectURL` nor `Blob.text()`, so the
 * blob handed to the browser is captured here and read back through a
 * `FileReader`, which jsdom does implement.
 */
let blobs: Blob[] = [];
let revoked: string[] = [];
let clickCount = 0;

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** The single anchor the helper appends, while it is still in the document. */
function currentLink(): HTMLAnchorElement | null {
  return document.body.querySelector("a");
}

beforeEach(() => {
  blobs = [];
  revoked = [];
  clickCount = 0;

  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:mock/${blobs.length}`;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });

  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clickCount++;
    // The anchor is still attached at click time; that is what makes the
    // download fire in a real browser.
    expect(this.isConnected).toBe(true);
    expect(this.getAttribute("href")).toMatch(/^blob:mock\//);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("downloadCSV", () => {
  const rows = [
    { action: "REPO_ADDED", resource: "acme/app" },
    { action: "REPO_REMOVED", resource: "acme/other" },
  ];

  it("hands the browser a CSV blob under the requested filename", async () => {
    downloadCSV(rows, "audit-logs-2026-09-20.csv");

    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/csv;charset=utf-8;");
    expect(clickCount).toBe(1);

    const body = ["action,resource", "REPO_ADDED,acme/app", "REPO_REMOVED,acme/other"].join(
      CSV_ROW_SEPARATOR,
    );

    // FileReader.readAsText strips a leading BOM, so the text is compared
    // without it and the BOM is checked by byte length instead. Excel on
    // Windows needs it: without one it assumes the host ANSI code page and
    // renders any non-ASCII repository name as mojibake.
    expect(await readBlob(blobs[0])).toBe(body);
    expect(blobs[0].size).toBe(new TextEncoder().encode(CSV_BOM + body).length);
  });

  it("names the download and then cleans up after itself", () => {
    downloadCSV(rows, "audit-logs-2026-09-20.csv");

    // Nothing is left behind: no orphan anchor, and the object URL is released
    // rather than pinned for the lifetime of the tab.
    expect(currentLink()).toBeNull();
    expect(revoked).toEqual(["blob:mock/1"]);
  });

  it("sets the download attribute to the filename it was given", () => {
    // Captured during the click, since the anchor is removed immediately after.
    let downloadAttr: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadAttr = this.getAttribute("download");
    });

    downloadCSV(rows, "audit-logs-2026-09-20.csv");
    expect(downloadAttr).toBe("audit-logs-2026-09-20.csv");
  });

  it("carries the shared formula-injection defence into the download", async () => {
    // A repository can be named `=cmd|'/c calc'!A1`, and that string reaches
    // this helper verbatim. It must arrive neutralised, exactly as the
    // server-side export route produces it.
    downloadCSV([{ resource: "=cmd|'/c calc'!A1" }], "x.csv");

    // No quoting: the value holds no comma, quote or newline, so RFC 4180
    // leaves it bare. The leading apostrophe is the whole defence.
    expect(await readBlob(blobs[0])).toBe(
      ["resource", "'=cmd|'/c calc'!A1"].join(CSV_ROW_SEPARATOR),
    );
  });

  it("does nothing for an empty or missing list", () => {
    downloadCSV([], "x.csv");
    downloadCSV(undefined as never, "x.csv");
    downloadCSV(null as never, "x.csv");

    expect(blobs).toHaveLength(0);
    expect(clickCount).toBe(0);
    expect(currentLink()).toBeNull();
  });

  it("does nothing when the rows serialise to nothing", () => {
    // Rows with no keys produce no header and no body, so there is no file to
    // offer.
    downloadCSV([{}, {}], "x.csv");

    expect(blobs).toHaveLength(0);
    expect(clickCount).toBe(0);
  });

  it("releases the object URL even when the click throws", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("popup blocked");
    });

    expect(() => downloadCSV(rows, "x.csv")).toThrow("popup blocked");

    // Both halves of the cleanup run: no leaked anchor, no leaked blob.
    expect(currentLink()).toBeNull();
    expect(revoked).toEqual(["blob:mock/1"]);
  });
});

describe("downloadJSON", () => {
  it("hands the browser pretty-printed JSON", async () => {
    const data = [{ id: "1", action: "REPO_ADDED", metadata: null }];
    downloadJSON(data, "audit-logs-2026-09-20.json");

    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("application/json;charset=utf-8;");

    const text = await readBlob(blobs[0]);
    expect(text).toBe(JSON.stringify(data, null, 2));
    // Two-space indentation, so the file is readable rather than one long line.
    expect(text).toContain('\n  {\n    "id": "1"');
  });

  it("cleans up the anchor and the object URL", () => {
    downloadJSON([{ id: "1" }], "x.json");

    expect(currentLink()).toBeNull();
    expect(revoked).toEqual(["blob:mock/1"]);
  });

  it("serialises an empty array rather than skipping it", async () => {
    // Unlike downloadCSV, an empty array is still valid JSON worth writing.
    downloadJSON([], "x.json");

    expect(blobs).toHaveLength(1);
    expect(await readBlob(blobs[0])).toBe("[]");
  });

  it("does nothing for null or undefined", () => {
    downloadJSON(null, "x.json");
    downloadJSON(undefined, "x.json");

    expect(blobs).toHaveLength(0);
    expect(clickCount).toBe(0);
  });

  it("releases the object URL even when the click throws", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("popup blocked");
    });

    expect(() => downloadJSON([{ id: "1" }], "x.json")).toThrow("popup blocked");

    expect(currentLink()).toBeNull();
    expect(revoked).toEqual(["blob:mock/1"]);
  });
});
