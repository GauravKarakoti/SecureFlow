import { describe, it, expect, vi } from "vitest";
import {
  IGNORED_BASENAMES,
  IGNORED_DIRECTORIES,
  IGNORED_EXTENSIONS,
  DEFAULT_LOCKFILES,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_IGNORE_DIRECTORIES,
  basenameOf,
  hasIgnoredBasename,
  hasIgnoredExtension,
  ignoreReasonFor,
  isUnderIgnoredDirectory,
  normalizeScanPath,
  pathSegments,
  shouldIgnorePath,
  parseSecureFlowIgnore,
  isDefaultIgnored,
  isForceIncluded,
  isSkippedByDefault,
  resolveDefaultSkippedFiles,
} from "./ignore-rules";
import { compileIgnorePatterns, shouldIgnore } from "./scanner";

describe("normalizeScanPath", () => {
  it("lower-cases and unifies separators", () => {
    expect(normalizeScanPath("Src\\Lib\\Auth.TS")).toBe("src/lib/auth.ts");
  });

  it("strips a leading ./ or /", () => {
    expect(normalizeScanPath("./src/app.ts")).toBe("src/app.ts");
    expect(normalizeScanPath("/src/app.ts")).toBe("src/app.ts");
  });
});

describe("pathSegments / basenameOf", () => {
  it("drops empty segments from a doubled separator", () => {
    expect(pathSegments("src//lib/auth.ts")).toEqual(["src", "lib", "auth.ts"]);
  });

  it("reads the basename", () => {
    expect(basenameOf("apps/web/package.json")).toBe("package.json");
    expect(basenameOf("package.json")).toBe("package.json");
    expect(basenameOf("")).toBe("");
  });
});

describe("isUnderIgnoredDirectory", () => {
  it("matches a segment at the root or nested", () => {
    expect(isUnderIgnoredDirectory("dist/output.js", "dist/")).toBe(true);
    expect(isUnderIgnoredDirectory("apps/web/dist/output.js", "dist/")).toBe(true);
  });

  it("does not match a directory that merely contains the rule as a substring", () => {
    // The bug, stated directly. `'build/'.includes` matched every one of these.
    expect(isUnderIgnoredDirectory("scripts/prebuild/inject.ts", "build/")).toBe(false);
    expect(isUnderIgnoredDirectory("packages/api-build/src/auth.ts", "build/")).toBe(false);
    expect(isUnderIgnoredDirectory("infra/redist/creds.ts", "dist/")).toBe(false);
  });

  it("requires a multi-segment rule to appear as a consecutive run", () => {
    expect(isUnderIgnoredDirectory("prisma/migrations/001.sql", "prisma/migrations/")).toBe(true);
    expect(
      isUnderIgnoredDirectory("apps/api/prisma/migrations/001.sql", "prisma/migrations/"),
    ).toBe(true);
    expect(isUnderIgnoredDirectory("myprisma/migrations/001.sql", "prisma/migrations/")).toBe(
      false,
    );
    expect(isUnderIgnoredDirectory("prisma/schema/migrations/001.sql", "prisma/migrations/")).toBe(
      false,
    );
  });

  it("does not treat a file named after the rule as a directory match", () => {
    // `src/build` is a file called build, not a build directory.
    expect(isUnderIgnoredDirectory("src/build", "build/")).toBe(false);
  });
});

describe("hasIgnoredExtension", () => {
  it("keeps the endsWith behaviour, which was already boundary-correct", () => {
    expect(hasIgnoredExtension("package-lock.json")).toBe(true);
    expect(hasIgnoredExtension("readme.md")).toBe(true);
    expect(hasIgnoredExtension("apps/web/tsconfig.json")).toBe(true);
    expect(hasIgnoredExtension("src/logo.svg")).toBe(true);
  });

  it("does not fire on a path that merely contains the extension", () => {
    expect(hasIgnoredExtension("src/md-renderer.ts")).toBe(false);
    expect(hasIgnoredExtension("src/csv-export.ts")).toBe(false);
  });
});

describe("hasIgnoredBasename", () => {
  it("matches the configuration files exactly", () => {
    expect(hasIgnoredBasename("package.json")).toBe(true);
    expect(hasIgnoredBasename("apps/web/package.json")).toBe(true);
    expect(hasIgnoredBasename(".gitignore")).toBe(true);
    expect(hasIgnoredBasename("prisma.config.ts")).toBe(true);
  });

  it("does not match a source file whose name merely contains one", () => {
    // The second half of the bug: the old rule was not anchored to a separator
    // at all, so any path carrying these eleven characters was dropped.
    expect(hasIgnoredBasename("tools/package.json.generator.ts")).toBe(false);
    expect(hasIgnoredBasename("src/config/gitignore-parser.ts")).toBe(false);
    expect(hasIgnoredBasename("docs/package.json-schema.ts")).toBe(false);
  });
});

describe("ignoreReasonFor", () => {
  it("names the rule that fired", () => {
    expect(ignoreReasonFor("node_modules/pkg/index.js")).toBe("directory");
    expect(ignoreReasonFor("README.md")).toBe("extension");
    expect(ignoreReasonFor("package.json")).toBe("config-file");
    expect(ignoreReasonFor("src/app.ts", compileIgnorePatterns(["src/"]))).toBe("custom");
  });

  it("returns null for a file that should be scanned", () => {
    expect(ignoreReasonFor("src/app.ts")).toBeNull();
  });

  it("treats an empty filename as scannable rather than throwing", () => {
    expect(ignoreReasonFor("")).toBeNull();
    expect(ignoreReasonFor("   ")).toBeNull();
  });
});

describe("shouldIgnorePath — files that must still be ignored", () => {
  const stillIgnored = [
    "dist/output.js",
    "build/main.js",
    ".next/static/chunk.js",
    "node_modules/package/index.js",
    "prisma/migrations/20260101_init/migration.sql",
    "apps/web/node_modules/left-pad/index.js",
    "package-lock.json",
    "package.json",
    "components.json",
    "prisma.config.ts",
    ".gitignore",
    "README.md",
    "docs/architecture.md",
    "public/logo.svg",
    "data/export.csv",
    "yarn.lock",
    "pnpm-lock.yaml",
  ];

  it.each(stillIgnored)("still ignores %s", (path) => {
    expect(shouldIgnorePath(path)).toBe(true);
  });
});

describe("shouldIgnorePath — files that were being skipped and should not be", () => {
  // Every one of these returned true under the old substring matching, so the
  // AI never read them, and the pull request still received a PASS and a "Scan
  // completed successfully" comment naming a file count that included them.
  const wronglySkipped = [
    "scripts/prebuild/inject-secrets.ts",
    "scripts/postbuild/sign.ts",
    "packages/api-build/src/auth.ts",
    "infra/gradle-build/settings.ts",
    "infra/redist/credentials.ts",
    "services/cdndist/keys.ts",
    "tools/package.json.generator.ts",
    "docs/package.json-schema.ts",
    "src/config/gitignore-parser.ts",
    "apps/web/components.json.builder.ts",
    "myprisma/migrations/loader.ts",
  ];

  it.each(wronglySkipped)("now scans %s", (path) => {
    expect(shouldIgnorePath(path)).toBe(false);
  });

  it("still scans ordinary source files", () => {
    expect(shouldIgnorePath("src/app.ts")).toBe(false);
    expect(shouldIgnorePath("src/components/Button.tsx")).toBe(false);
  });

  it("still scans .env.example, which is where a real committed key shows up", () => {
    expect(shouldIgnorePath(".env.example")).toBe(false);
    expect(shouldIgnorePath(".env.sample")).toBe(false);
  });
});

describe("custom .secureflowignore patterns", () => {
  it("are applied unchanged", () => {
    const compiled = compileIgnorePatterns(["custom-dir/"]);
    expect(shouldIgnorePath("custom-dir/some-file.ts", compiled)).toBe(true);
    expect(shouldIgnorePath("src/some-file.ts", compiled)).toBe(false);
  });

  it("are matched against a separator-normalised path", () => {
    const compiled = compileIgnorePatterns(["vendor/"]);
    expect(shouldIgnorePath("vendor\\lib\\thing.ts", compiled)).toBe(true);
  });
});

describe("the rule tables themselves", () => {
  it("has not lost an entry in the move out of scanner.ts", () => {
    expect(IGNORED_DIRECTORIES).toEqual([
      "dist/",
      "build/",
      ".next/",
      "node_modules/",
      "prisma/migrations/",
    ]);
    expect(IGNORED_BASENAMES).toEqual([
      "package.json",
      "components.json",
      "prisma.config.ts",
      ".gitignore",
    ]);
    expect(IGNORED_EXTENSIONS).toContain(".md");
    expect(IGNORED_EXTENSIONS).toContain("lock.json");
  });
});

describe("scanner.shouldIgnore still delegates here", () => {
  it("agrees with shouldIgnorePath, so the ~10 existing importers are unaffected", () => {
    for (const path of [
      "dist/output.js",
      "src/app.ts",
      "package.json",
      "scripts/prebuild/inject-secrets.ts",
    ]) {
      expect(shouldIgnore(path)).toBe(shouldIgnorePath(path));
    }
  });
});

describe("parseSecureFlowIgnore and entry expiration (#1811)", () => {
  const fixedNow = new Date("2026-11-18T12:00:00.000Z");

  it("handles old plain format with comments and sections (backward compatibility)", () => {
    const content = `
      # Comment at top
      dist/
      build/
      *.test.ts

      [placeholders]
      mock_token_123
      # Another comment
      test_dummy_key
    `;
    const config = parseSecureFlowIgnore(content, { now: fixedNow });

    expect(config.ignoredPaths).toEqual(["dist/", "build/", "*.test.ts"]);
    expect(config.placeholders).toEqual(["mock_token_123", "test_dummy_key"]);
    expect(config.expiredRules).toEqual([]);
    expect(config.warnings).toHaveLength(3); // 3 rules without reason
  });

  it("parses new format entries with bracket attributes [expires=...] and [reason=...]", () => {
    const content = `
      tests/** [expires=2026-12-31]: Temporary test fixtures
      legacy/old.ts [expires=2026-12-31] [reason=Deprecated old module]
      fixtures/*.json [reason=Static test files]
    `;
    const config = parseSecureFlowIgnore(content, { now: fixedNow });

    expect(config.ignoredPaths).toEqual(["tests/**", "legacy/old.ts", "fixtures/*.json"]);
    expect(config.expiredRules).toEqual([]);
    expect(config.warnings).toEqual([]);
    expect(config.rules).toHaveLength(3);
    expect(config.rules?.[0]).toEqual({
      pattern: "tests/**",
      reason: "Temporary test fixtures",
      expires: "2026-12-31",
      rawExpires: "2026-12-31",
    });
  });

  it("parses colon reason, hash comment reason, and JSON line entries", () => {
    const content = `
      vendor/**: Third party code
      samples/** # reason: Example files for documentation
      {"pattern": "mocks/**", "reason": "Test mocks", "expires": "2026-12-31"}
    `;
    const config = parseSecureFlowIgnore(content, { now: fixedNow });

    expect(config.ignoredPaths).toEqual(["vendor/**", "samples/**", "mocks/**"]);
    expect(config.rules?.[0]?.reason).toBe("Third party code");
    expect(config.rules?.[1]?.reason).toBe("Example files for documentation");
    expect(config.rules?.[2]?.reason).toBe("Test mocks");
    expect(config.rules?.[2]?.expires).toBe("2026-12-31");
  });

  it("parses full JSON file format with entries array", () => {
    const content = JSON.stringify({
      ignoredPaths: [
        "dist/**",
        { pattern: "temp/**", reason: "Temporary scratch", expires: "2026-12-31" },
      ],
      placeholders: ["fake_key"],
    });
    const config = parseSecureFlowIgnore(content, { now: fixedNow });

    expect(config.ignoredPaths).toEqual(["dist/**", "temp/**"]);
    expect(config.placeholders).toEqual(["fake_key"]);
    expect(config.rules?.[1]?.reason).toBe("Temporary scratch");
  });

  it("stops applying expired entries and records them in expiredRules", () => {
    const content = `
      active/** [expires=2026-12-31]: Still active through end of year
      expired-bracket/** [expires=2026-11-01]: Expired earlier this month
      expired-comment/** # expires=2026-10-15 reason: Expired in October
      {"pattern": "expired-json/**", "reason": "Expired JSON rule", "expires": "2026-09-01"}
    `;
    const config = parseSecureFlowIgnore(content, { now: fixedNow });

    // Only active pattern survives in ignoredPaths
    expect(config.ignoredPaths).toEqual(["active/**"]);

    // Expired patterns are tracked under expiredRules
    expect(config.expiredRules).toEqual([
      {
        pattern: "expired-bracket/**",
        expires: "2026-11-01",
        reason: "Expired earlier this month",
      },
      {
        pattern: "expired-comment/**",
        expires: "2026-10-15",
        reason: "Expired in October",
      },
      {
        pattern: "expired-json/**",
        expires: "2026-09-01",
        reason: "Expired JSON rule",
      },
    ]);
  });

  describe("boundary testing (exactly at target, just over, no date)", () => {
    it("evaluates YYYY-MM-DD through the end of that day in UTC (active on same day, expired next day)", () => {
      const content = `tests/** [expires=2026-11-18]: Test fixtures for sprint`;

      // 1. Same day in UTC (before 23:59:59.999Z): still active
      const duringDay = new Date("2026-11-18T23:59:59.000Z");
      const activeConfig = parseSecureFlowIgnore(content, { now: duringDay });
      expect(activeConfig.ignoredPaths).toEqual(["tests/**"]);
      expect(activeConfig.expiredRules).toEqual([]);

      // 2. Next day in UTC (just after midnight 00:00:00.000Z): expired
      const nextDay = new Date("2026-11-19T00:00:00.000Z");
      const expiredConfig = parseSecureFlowIgnore(content, { now: nextDay });
      expect(expiredConfig.ignoredPaths).toEqual([]);
      expect(expiredConfig.expiredRules).toEqual([
        {
          pattern: "tests/**",
          expires: "2026-11-18",
          reason: "Test fixtures for sprint",
        },
      ]);
    });

    it("evaluates exact ISO timestamp boundaries correctly", () => {
      const targetTime = "2026-11-18T15:30:00.000Z";
      const content = `precise/** [expires=${targetTime}]: Precise timestamp rule`;

      // Exactly at target: not expired
      const exactNow = new Date("2026-11-18T15:30:00.000Z");
      const exactConfig = parseSecureFlowIgnore(content, { now: exactNow });
      expect(exactConfig.ignoredPaths).toEqual(["precise/**"]);
      expect(exactConfig.expiredRules).toEqual([]);

      // Just over target (1ms later): expired
      const justOverNow = new Date("2026-11-18T15:30:00.001Z");
      const justOverConfig = parseSecureFlowIgnore(content, { now: justOverNow });
      expect(justOverConfig.ignoredPaths).toEqual([]);
      expect(justOverConfig.expiredRules).toHaveLength(1);
    });

    it("entries without a date never expire", () => {
      const content = `permanent/**: Permanent rule without expiry`;
      const futureNow = new Date("2035-01-01T00:00:00.000Z");
      const config = parseSecureFlowIgnore(content, { now: futureNow });

      expect(config.ignoredPaths).toEqual(["permanent/**"]);
      expect(config.expiredRules).toEqual([]);
    });
  });

  describe("malformed and invalid dates", () => {
    it("reports invalid calendar date (e.g. Feb 31) and keeps rule active without crashing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = `fixtures/** [expires=2026-02-31]: Invalid day in February`;

      const config = parseSecureFlowIgnore(content, { now: fixedNow });

      expect(config.ignoredPaths).toEqual(["fixtures/**"]);
      expect(config.expiredRules).toEqual([]);
      expect(config.warnings).toEqual([
        'Invalid expiration date "2026-02-31" for rule "fixtures/**"; ignoring expiration date.',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid expiration date "2026-02-31"'),
      );
      warnSpy.mockRestore();
    });

    it("reports invalid date strings (e.g. tomorrow, 2026-13-45) without crashing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = `
        temp1/** [expires=tomorrow]: Not an ISO date
        temp2/** [expires=2026-13-45]: Month out of range
      `;

      const config = parseSecureFlowIgnore(content, { now: fixedNow });

      expect(config.ignoredPaths).toEqual(["temp1/**", "temp2/**"]);
      expect(config.expiredRules).toEqual([]);
      expect(config.warnings).toHaveLength(2);
      expect(config.warnings?.[0]).toContain('Invalid expiration date "tomorrow"');
      expect(config.warnings?.[1]).toContain('Invalid expiration date "2026-13-45"');
      warnSpy.mockRestore();
    });
  });

  describe("missing reason warning", () => {
    it("warns when an entry has no reason without failing or crashing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = `unexplained/**`;

      const config = parseSecureFlowIgnore(content, { now: fixedNow });

      expect(config.ignoredPaths).toEqual(["unexplained/**"]);
      expect(config.warnings).toEqual(['Ignore rule "unexplained/**" has no reason specified.']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignore rule "unexplained/**" has no reason specified.'),
      );
      warnSpy.mockRestore();
    });
  });

  describe("built-in default ignore patterns (#1983)", () => {
    it("includes common lockfiles in default ignore patterns", () => {
      const lockfiles = [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "bun.lock",
        "Cargo.lock",
        "Gemfile.lock",
        "composer.lock",
        "poetry.lock",
        "Pipfile.lock",
        "flake.lock",
      ];

      for (const lf of lockfiles) {
        expect(isDefaultIgnored(lf)).toBe(true);
        expect(isDefaultIgnored(`packages/core/${lf}`)).toBe(true);
        expect(shouldIgnorePath(lf)).toBe(true);
      }
    });

    it("ignores minified bundles and source maps", () => {
      expect(isDefaultIgnored("bundle.min.js")).toBe(true);
      expect(isDefaultIgnored("assets/style.min.css")).toBe(true);
      expect(isDefaultIgnored("vendor/app.min.mjs")).toBe(true);
      expect(isDefaultIgnored("vendor/app.min.cjs")).toBe(true);
      expect(isDefaultIgnored("dist/main.js.map")).toBe(true);
      expect(isDefaultIgnored("main.map")).toBe(true);

      // Regular files are not ignored
      expect(isDefaultIgnored("src/app.js")).toBe(false);
      expect(isDefaultIgnored("src/theme.css")).toBe(false);
    });

    it("ignores build, vendor, node_modules, and test snapshot directories", () => {
      expect(isDefaultIgnored("dist/bundle.js")).toBe(true);
      expect(isDefaultIgnored("build/index.html")).toBe(true);
      expect(isDefaultIgnored("vendor/oauth/client.go")).toBe(true);
      expect(isDefaultIgnored("node_modules/lodash/index.js")).toBe(true);
      expect(isDefaultIgnored("tests/__snapshots__/component.test.snap")).toBe(true);
      expect(isDefaultIgnored("apps/web/__snapshots__/modal.test.snap")).toBe(true);
    });

    it("ignores generated protobuf files and directories", () => {
      expect(isDefaultIgnored("api/user_pb2.py")).toBe(true);
      expect(isDefaultIgnored("api/service_pb2_grpc.py")).toBe(true);
      expect(isDefaultIgnored("gen/service.pb.go")).toBe(true);
      expect(isDefaultIgnored("gen/service.pb.cc")).toBe(true);
      expect(isDefaultIgnored("gen/service.pb.h")).toBe(true);
      expect(isDefaultIgnored("gen/service_pb_test.go")).toBe(true);
      expect(isDefaultIgnored("proto/gen/v1/auth.go")).toBe(true);
      expect(isDefaultIgnored("google/protobuf/timestamp.proto")).toBe(true);
    });

    it("ignores OpenAPI client directories", () => {
      expect(isDefaultIgnored("client/openapi/api.ts")).toBe(true);
      expect(isDefaultIgnored("generated/openapi/index.ts")).toBe(true);
      expect(isDefaultIgnored("openapi/generated/client.ts")).toBe(true);
      expect(isDefaultIgnored("generated/client.ts")).toBe(true);
      expect(isDefaultIgnored("apps/web/generated/api.ts")).toBe(true);
    });

    it("allows repositories to disable defaults with includeDefaults: false", () => {
      const options = { includeDefaults: false };
      expect(isSkippedByDefault("package-lock.json", [], options)).toBe(false);
      expect(isSkippedByDefault("vendor/lib.js", [], options)).toBe(false);
      expect(isSkippedByDefault("dist/bundle.js", [], options)).toBe(false);
      expect(shouldIgnorePath("package-lock.json", [], options)).toBe(false);
      expect(shouldIgnorePath("vendor/lib.js", [], options)).toBe(false);
    });

    it("allows repositories to override defaults with forceInclude", () => {
      const options = { forceInclude: ["vendor/**", "*.min.js"] };
      expect(isSkippedByDefault("vendor/lib.js", [], options)).toBe(false);
      expect(isSkippedByDefault("bundle.min.js", [], options)).toBe(false);
      expect(shouldIgnorePath("vendor/lib.js", [], options)).toBe(false);
      expect(shouldIgnorePath("bundle.min.js", [], options)).toBe(false);

      // Other defaults remain ignored
      expect(isSkippedByDefault("package-lock.json", [], options)).toBe(true);
      expect(shouldIgnorePath("package-lock.json", [], options)).toBe(true);
    });

    it("keeps .secureflowignore custom rules working as before", () => {
      const custom = compileIgnorePatterns(["src/legacy/**"]);
      expect(shouldIgnorePath("src/legacy/code.ts", custom)).toBe(true);
      expect(ignoreReasonFor("src/legacy/code.ts", custom)).toBe("custom");
      // Not counted as skipped by defaults
      expect(isSkippedByDefault("src/legacy/code.ts", custom)).toBe(false);
    });

    describe("resolveDefaultSkippedFiles and the single changed file exception", () => {
      it("counts skipped files when default patterns apply", () => {
        const files = [
          { filename: "package-lock.json", patch: "+ line" },
          { filename: "vendor/foo.js", patch: "+ line" },
          { filename: "src/index.ts", patch: "+ line" },
        ];

        const result = resolveDefaultSkippedFiles(files);
        expect(result.skippedCount).toBe(2);
        expect(result.skippedByDefault.has("package-lock.json")).toBe(true);
        expect(result.skippedByDefault.has("vendor/foo.js")).toBe(true);
        expect(result.skippedByDefault.has("src/index.ts")).toBe(false);
      });

      it("does not count files when includeDefaults is false", () => {
        const files = [
          { filename: "package-lock.json", patch: "+ line" },
          { filename: "vendor/foo.js", patch: "+ line" },
        ];

        const result = resolveDefaultSkippedFiles(files, [], { includeDefaults: false });
        expect(result.skippedCount).toBe(0);
        expect(result.skippedByDefault.size).toBe(0);
      });

      it("respects forceInclude overrides", () => {
        const files = [
          { filename: "vendor/foo.js", patch: "+ line" },
          { filename: "dist/bundle.js", patch: "+ line" },
        ];

        const result = resolveDefaultSkippedFiles(files, [], { forceInclude: ["vendor/**"] });
        expect(result.skippedCount).toBe(1);
        expect(result.skippedByDefault.has("vendor/foo.js")).toBe(false);
        expect(result.skippedByDefault.has("dist/bundle.js")).toBe(true);
      });

      it("never skips files because of defaults if they are the only files changed and contain secret-like strings", () => {
        const files = [{ filename: "package-lock.json", patch: "+ secret" }];
        const result = resolveDefaultSkippedFiles(files, [], {
          hasDeterministicSecrets: (f) => f.filename === "package-lock.json",
        });

        expect(result.skippedCount).toBe(0);
        expect(result.skippedByDefault.has("package-lock.json")).toBe(false);
      });

      it("skips files by default if they are the only files changed but contain NO secrets", () => {
        const files = [{ filename: "package-lock.json", patch: "+ normal" }];
        const result = resolveDefaultSkippedFiles(files, [], {
          hasDeterministicSecrets: () => false,
        });

        expect(result.skippedCount).toBe(1);
        expect(result.skippedByDefault.has("package-lock.json")).toBe(true);
      });

      it("skips default file from LLM scanning when other files are changed, even if it has a secret", () => {
        const files = [
          { filename: "package-lock.json", patch: "+ secret" },
          { filename: "src/app.ts", patch: "+ normal" },
        ];
        const result = resolveDefaultSkippedFiles(files, [], {
          hasDeterministicSecrets: (f) => f.filename === "package-lock.json",
        });

        expect(result.skippedCount).toBe(1);
        expect(result.skippedByDefault.has("package-lock.json")).toBe(true);
      });
    });
  });
});
