import { describe, it, expect } from "vitest";
import {
  CliUsageError,
  OUTPUT_FORMATS,
  optionValue,
  parseIgnoreFilePath,
  parseOutputFormat,
  parseOutputPath,
} from "./output-args.js";

const argv = (...args: string[]) => ["node", "secureflow", ...args];

describe("optionValue", () => {
  it("reads the space-separated and the inline form", () => {
    expect(optionValue(argv("--format", "json"), ["--format"])).toBe("json");
    expect(optionValue(argv("--format=json"), ["--format"])).toBe("json");
  });

  it("splits the inline form on the first = only", () => {
    expect(optionValue(argv("--output=reports/a=b.json"), ["--output"])).toBe("reports/a=b.json");
  });

  it("is undefined when the flag is absent and null when it has no value", () => {
    expect(optionValue(argv("--verbose"), ["--format"])).toBeUndefined();
    expect(optionValue(argv("--format"), ["--format"])).toBeNull();
    expect(optionValue(argv("--format="), ["--format"])).toBeNull();
    expect(optionValue(argv("--format", "--verbose"), ["--format"])).toBeNull();
  });

  it("does not treat a longer flag sharing the prefix as a match", () => {
    expect(optionValue(argv("--formatter", "x"), ["--format"])).toBeUndefined();
  });
});

describe("parseOutputFormat", () => {
  it("defaults to text", () => {
    expect(parseOutputFormat(argv())).toBe("text");
  });

  it.each(OUTPUT_FORMATS)("accepts %s in both forms and any case", (format) => {
    expect(parseOutputFormat(argv("--format", format))).toBe(format);
    expect(parseOutputFormat(argv(`--format=${format.toUpperCase()}`))).toBe(format);
  });

  it("maps md to markdown", () => {
    expect(parseOutputFormat(argv("--format", "md"))).toBe("markdown");
  });

  it("recognises --format=sarif, which used to fall back to text", () => {
    // With `-o out.sarif` this wrote the plain-text report into the .sarif file.
    expect(parseOutputFormat(argv("--format=sarif", "-o", "out.sarif"))).toBe("sarif");
  });

  it("rejects an unknown format instead of silently producing text", () => {
    expect(() => parseOutputFormat(argv("--format", "sarfi"))).toThrow(CliUsageError);
    expect(() => parseOutputFormat(argv("--format=xml"))).toThrow(/Unknown --format "xml"/);
  });

  it("rejects a missing value", () => {
    expect(() => parseOutputFormat(argv("--format"))).toThrow(/--format requires a value/);
  });
});

describe("parseOutputPath", () => {
  it("reads -o, --output and --output=", () => {
    expect(parseOutputPath(argv("-o", "r.json"))).toBe("r.json");
    expect(parseOutputPath(argv("--output", "r.json"))).toBe("r.json");
    expect(parseOutputPath(argv("--output=r.json"))).toBe("r.json");
  });

  it("is null for stdout and an error when the path is missing", () => {
    expect(parseOutputPath(argv("--format", "json"))).toBeNull();
    expect(() => parseOutputPath(argv("-o"))).toThrow(CliUsageError);
  });
});

describe("parseIgnoreFilePath", () => {
  it("reads --ignore-file and --ignore in both forms", () => {
    expect(parseIgnoreFilePath(argv("--ignore-file", ".sfignore"))).toBe(".sfignore");
    expect(parseIgnoreFilePath(argv("--ignore", ".sfignore"))).toBe(".sfignore");
    expect(parseIgnoreFilePath(argv("--ignore-file=.sfignore"))).toBe(".sfignore");
  });

  it("keeps a path containing =", () => {
    expect(parseIgnoreFilePath(argv("--ignore-file=conf/a=b.json"))).toBe("conf/a=b.json");
  });

  it("is undefined when absent", () => {
    expect(parseIgnoreFilePath(argv())).toBeUndefined();
  });
});
