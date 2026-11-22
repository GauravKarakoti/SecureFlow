import { describe, it, expect } from "vitest";
import {
  CliUsageError,
  OUTPUT_FORMATS,
  optionValue,
  parseIgnoreFilePath,
  parseOutputFormat,
  parseOutputPath,
  parseSinceArg,
  parseVoiceArg,
  parseColorArg,
  parseNoCacheArg,
  parseCacheClearArg,
  parseCachePruneArg,
  parseCacheStatsArg,
  parseCacheTtlArg,
  parseCacheMaxSizeArg,
  parseCacheDirArg,
  parseTargetDirectoryArg,
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

describe("parseVoiceArg", () => {
  it("is false when the flag is absent", () => {
    expect(parseVoiceArg(argv())).toBe(false);
    expect(parseVoiceArg(argv("--format", "json"))).toBe(false);
  });

  it("is true for a bare --voice or -v", () => {
    expect(parseVoiceArg(argv("--voice"))).toBe(true);
    expect(parseVoiceArg(argv("-v"))).toBe(true);
  });

  it("honours explicit boolean-ish values, case-insensitively", () => {
    expect(parseVoiceArg(argv("--voice=false"))).toBe(false);
    expect(parseVoiceArg(argv("--voice=0"))).toBe(false);
    expect(parseVoiceArg(argv("--voice=FALSE"))).toBe(false);
    expect(parseVoiceArg(argv("--voice=true"))).toBe(true);
    expect(parseVoiceArg(argv("--voice=1"))).toBe(true);
  });

  it("first match wins", () => {
    expect(parseVoiceArg(argv("--voice=false", "--voice"))).toBe(false);
    expect(parseVoiceArg(argv("--voice", "--voice=false"))).toBe(true);
  });
});

describe("parseSinceArg", () => {
  it("is undefined when the flag is absent", () => {
    expect(parseSinceArg(argv())).toBeUndefined();
    expect(parseSinceArg(argv("--format", "json"))).toBeUndefined();
  });

  it("reads --since <ref> and --since=<ref>", () => {
    expect(parseSinceArg(argv("--since", "origin/main"))).toBe("origin/main");
    expect(parseSinceArg(argv("--since=main"))).toBe("main");
    expect(parseSinceArg(argv("--since=HEAD~1"))).toBe("HEAD~1");
  });

  it("rejects a missing or empty ref", () => {
    expect(() => parseSinceArg(argv("--since"))).toThrow(CliUsageError);
    expect(() => parseSinceArg(argv("--since"))).toThrow(/--since requires a git reference/);
    expect(() => parseSinceArg(argv("--since="))).toThrow(CliUsageError);
    expect(() => parseSinceArg(argv("--since", "--format=json"))).toThrow(CliUsageError);
  });
});

describe("parseColorArg", () => {
  it("returns undefined when neither flag is provided", () => {
    expect(parseColorArg(argv())).toBeUndefined();
    expect(parseColorArg(argv("--format", "json"))).toBeUndefined();
  });

  it("returns true for bare --color", () => {
    expect(parseColorArg(argv("--color"))).toBe(true);
  });

  it("returns false for bare --no-color", () => {
    expect(parseColorArg(argv("--no-color"))).toBe(false);
  });

  it("supports --color=always, --color=1, --color=true", () => {
    expect(parseColorArg(argv("--color=always"))).toBe(true);
    expect(parseColorArg(argv("--color=1"))).toBe(true);
    expect(parseColorArg(argv("--color=true"))).toBe(true);
    expect(parseColorArg(argv("--color=TRUE"))).toBe(true);
  });

  it("supports --color=never, --color=0, --color=false", () => {
    expect(parseColorArg(argv("--color=never"))).toBe(false);
    expect(parseColorArg(argv("--color=0"))).toBe(false);
    expect(parseColorArg(argv("--color=false"))).toBe(false);
    expect(parseColorArg(argv("--color=FALSE"))).toBe(false);
  });

  it("supports --no-color=false and --no-color=0 to retain color", () => {
    expect(parseColorArg(argv("--no-color=false"))).toBe(true);
    expect(parseColorArg(argv("--no-color=0"))).toBe(true);
  });

  it("last flag in argv takes precedence", () => {
    expect(parseColorArg(argv("--color", "--no-color"))).toBe(false);
    expect(parseColorArg(argv("--no-color", "--color"))).toBe(true);
    expect(parseColorArg(argv("--no-color", "--color=never"))).toBe(false);
    expect(parseColorArg(argv("--no-color", "--color=always"))).toBe(true);
  });
});

describe("parseNoCacheArg", () => {
  it("defaults to false when absent", () => {
    expect(parseNoCacheArg(argv())).toBe(false);
    expect(parseNoCacheArg(argv("--format", "json"))).toBe(false);
  });

  it("is true for bare --no-cache", () => {
    expect(parseNoCacheArg(argv("--no-cache"))).toBe(true);
  });

  it("supports boolean-ish values", () => {
    expect(parseNoCacheArg(argv("--no-cache=true"))).toBe(true);
    expect(parseNoCacheArg(argv("--no-cache=1"))).toBe(true);
    expect(parseNoCacheArg(argv("--no-cache=false"))).toBe(false);
    expect(parseNoCacheArg(argv("--no-cache=0"))).toBe(false);
  });
});

describe("parseCacheClearArg", () => {
  it("defaults to false when absent", () => {
    expect(parseCacheClearArg(argv())).toBe(false);
    expect(parseCacheClearArg(argv("--format", "json"))).toBe(false);
  });

  it("is true for cache-clear, cache clear, and --cache-clear", () => {
    expect(parseCacheClearArg(argv("cache-clear"))).toBe(true);
    expect(parseCacheClearArg(argv("cache", "clear"))).toBe(true);
    expect(parseCacheClearArg(argv("--cache-clear"))).toBe(true);
  });
});

describe("parseCacheDirArg", () => {
  it("defaults to undefined when absent", () => {
    expect(parseCacheDirArg(argv())).toBeUndefined();
  });

  it("reads --cache-dir <path> and --cache-dir=<path>", () => {
    expect(parseCacheDirArg(argv("--cache-dir", "/custom/cache"))).toBe("/custom/cache");
    expect(parseCacheDirArg(argv("--cache-dir=/custom/cache"))).toBe("/custom/cache");
  });

  it("rejects empty or missing directory path", () => {
    expect(() => parseCacheDirArg(argv("--cache-dir"))).toThrow(CliUsageError);
    expect(() => parseCacheDirArg(argv("--cache-dir="))).toThrow(CliUsageError);
  });
});

describe("parseTargetDirectoryArg (#1933)", () => {
  it("defaults to undefined when running standard staged scan", () => {
    expect(parseTargetDirectoryArg(argv())).toBeUndefined();
    expect(parseTargetDirectoryArg(argv("--no-cache"))).toBeUndefined();
    expect(parseTargetDirectoryArg(argv("--format", "json"))).toBeUndefined();
  });

  it("parses explicit --dir <path> and --dir=<path>", () => {
    expect(parseTargetDirectoryArg(argv("--dir", "src"))).toBe("src");
    expect(parseTargetDirectoryArg(argv("--dir=src/lib"))).toBe("src/lib");
  });

  it("rejects empty --dir argument", () => {
    expect(() => parseTargetDirectoryArg(argv("--dir"))).toThrow(CliUsageError);
    expect(() => parseTargetDirectoryArg(argv("--dir="))).toThrow(CliUsageError);
  });

  it("parses positional directory path arguments", () => {
    expect(parseTargetDirectoryArg(argv("src"))).toBe("src");
    expect(parseTargetDirectoryArg(argv("."))).toBe(".");
    expect(parseTargetDirectoryArg(argv("packages/core"))).toBe("packages/core");
    expect(parseTargetDirectoryArg(argv("scan", "src"))).toBe("src");
  });

  it("returns undefined for known subcommands", () => {
    expect(parseTargetDirectoryArg(argv("validate"))).toBeUndefined();
    expect(parseTargetDirectoryArg(argv("init"))).toBeUndefined();
    expect(parseTargetDirectoryArg(argv("mcp"))).toBeUndefined();
    expect(parseTargetDirectoryArg(argv("cache-clear"))).toBeUndefined();
  });
});

describe("parseCachePruneArg", () => {
  it("defaults to false when absent", () => {
    expect(parseCachePruneArg(argv())).toBe(false);
  });

  it("is true for cache-prune, cache prune, and --cache-prune", () => {
    expect(parseCachePruneArg(argv("cache-prune"))).toBe(true);
    expect(parseCachePruneArg(argv("cache", "prune"))).toBe(true);
    expect(parseCachePruneArg(argv("--cache-prune"))).toBe(true);
  });
});

describe("parseCacheStatsArg", () => {
  it("defaults to false when absent", () => {
    expect(parseCacheStatsArg(argv())).toBe(false);
  });

  it("is true for cache-stats, cache stats, and --cache-stats", () => {
    expect(parseCacheStatsArg(argv("cache-stats"))).toBe(true);
    expect(parseCacheStatsArg(argv("cache", "stats"))).toBe(true);
    expect(parseCacheStatsArg(argv("--cache-stats"))).toBe(true);
  });
});

describe("parseCacheTtlArg", () => {
  it("defaults to undefined when absent", () => {
    expect(parseCacheTtlArg(argv())).toBeUndefined();
  });

  it("parses --cache-ttl and --ttl values", () => {
    expect(parseCacheTtlArg(argv("--cache-ttl", "7d"))).toBe("7d");
    expect(parseCacheTtlArg(argv("--ttl=30d"))).toBe("30d");
  });

  it("rejects missing values", () => {
    expect(() => parseCacheTtlArg(argv("--ttl"))).toThrow(CliUsageError);
    expect(() => parseCacheTtlArg(argv("--cache-ttl="))).toThrow(CliUsageError);
  });
});

describe("parseCacheMaxSizeArg", () => {
  it("defaults to undefined when absent", () => {
    expect(parseCacheMaxSizeArg(argv())).toBeUndefined();
  });

  it("parses --cache-max-size and --max-size values", () => {
    expect(parseCacheMaxSizeArg(argv("--cache-max-size", "50MB"))).toBe("50MB");
    expect(parseCacheMaxSizeArg(argv("--max-size=100M"))).toBe("100M");
  });

  it("rejects missing values", () => {
    expect(() => parseCacheMaxSizeArg(argv("--max-size"))).toThrow(CliUsageError);
    expect(() => parseCacheMaxSizeArg(argv("--cache-max-size="))).toThrow(CliUsageError);
  });
});
