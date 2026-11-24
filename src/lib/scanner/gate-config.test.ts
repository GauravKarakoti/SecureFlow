import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseSecureFlowConfig,
  formatGateSummaryLine,
  isDefaultGate,
  loadTrustedGateConfig,
  loadBaseGateConfig,
  isAuthorSkipped,
  DEFAULT_GATE_CONFIG,
  SECUREFLOW_CONFIG_FILE,
  resolveScanTimeoutBudgetMs,
  resolveScanRequestTimeoutMs,
  DEFAULT_SCAN_TIMEOUT_BUDGET_SECONDS,
  DEFAULT_SCAN_REQUEST_TIMEOUT_SECONDS,
  resolveVerifyCritical,
  resolveMaxVerificationCalls,
  DEFAULT_MAX_VERIFICATION_CALLS,
  MAX_VERIFICATION_CALLS_LIMIT,
} from "./gate-config";
import { ArmorIQPolicyEngine } from "@/lib/armor/iq";
import type { ScanFinding } from "@/lib/armor/scanner";

const base64 = (str: string) => Buffer.from(str).toString("base64");

function makeFinding(type: string, severity: string | null | undefined): ScanFinding {
  return {
    type,
    severity: severity as any,
    fileLocation: "src/vuln.ts",
    description: "test finding",
    lineStart: 1,
    lineEnd: 2,
    codeSnippet: "test()",
  };
}

describe("gate-config loader and parser (#1491, #1470)", () => {
  let engine: ArmorIQPolicyEngine;

  beforeEach(() => {
    engine = new ArmorIQPolicyEngine();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("parseSecureFlowConfig", () => {
    it("parses valid config with blockOn and reviewOn", () => {
      const json = JSON.stringify({
        gate: {
          blockOn: "HIGH",
          reviewOn: "MEDIUM",
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.blockOn).toBe("HIGH");
      expect(config.reviewOn).toBe("MEDIUM");
      expect(config.overrides).toEqual([]);
    });

    it("supports blockAt and reviewAt aliases and case-insensitivity", () => {
      const json = JSON.stringify({
        gate: {
          blockAt: "high",
          reviewAt: "low",
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.blockOn).toBe("HIGH");
      expect(config.reviewOn).toBe("LOW");
    });

    it("supports NONE to turn off block or review gate", () => {
      const json = JSON.stringify({
        gate: {
          blockOn: "NONE",
          reviewOn: "HIGH",
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.blockOn).toBe("NONE");
      expect(config.reviewOn).toBe("HIGH");
    });

    it("parses type overrides correctly", () => {
      const json = JSON.stringify({
        gate: {
          blockOn: "CRITICAL",
          reviewOn: "MEDIUM",
          overrides: [{ type: "SECRET", blockAt: "MEDIUM" }],
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.blockOn).toBe("CRITICAL");
      expect(config.reviewOn).toBe("MEDIUM");
      expect(config.overrides).toHaveLength(1);
      expect(config.overrides?.[0]).toEqual({
        type: "SECRET",
        blockOn: "MEDIUM",
      });
    });

    it("Case 3 & 4: Safe failure on malformed JSON or invalid types, logs warning", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const badJson = "{ not valid json }";

      const config1 = parseSecureFlowConfig(badJson);
      expect(config1).toEqual(DEFAULT_GATE_CONFIG);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"));

      const nonObject = JSON.stringify("not-an-object");
      const config2 = parseSecureFlowConfig(nonObject);
      expect(config2).toEqual(DEFAULT_GATE_CONFIG);

      const invalidKey = JSON.stringify({ gate: { blockOn: "SUPER_CRITICAL" } });
      const config3 = parseSecureFlowConfig(invalidKey);
      expect(config3.blockOn).toBe(DEFAULT_GATE_CONFIG.blockOn);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown blockOn value"));
    });

    it("parses .secureflow.json containing comments without failing", () => {
      const jsonWithComments = `
        // SecureFlow Gate Configuration
        {
          "gate": {
            // Block on HIGH
            "blockOn": "HIGH",
            /* Review on LOW */
            "reviewOn": "LOW"
          }
        }
      `;
      const config = parseSecureFlowConfig(jsonWithComments);
      expect(config.blockOn).toBe("HIGH");
      expect(config.reviewOn).toBe("LOW");
    });
  });

  describe("formatGateSummaryLine", () => {
    it("returns null when gate is default", () => {
      expect(formatGateSummaryLine(DEFAULT_GATE_CONFIG)).toBeNull();
      expect(formatGateSummaryLine(null)).toBeNull();
      expect(formatGateSummaryLine(undefined)).toBeNull();
    });

    it("formats summary line when gate differs from default", () => {
      const summary = formatGateSummaryLine({
        blockOn: "HIGH",
        reviewOn: "MEDIUM",
      });
      expect(summary).toBe("Gate: block on HIGH+, review on MEDIUM+ (from base branch)");

      const summaryNone = formatGateSummaryLine({
        blockOn: "NONE",
        reviewOn: "HIGH",
      });
      expect(summaryNone).toBe("Gate: block off, review on HIGH+ (from base branch)");
    });
  });

  describe("Acceptance criteria test scenarios", () => {
    it("Case 1: Happy path: tighten - one HIGH finding with blockOn: HIGH gives BLOCKED", () => {
      const findings = [makeFinding("VULNERABILITY", "HIGH")];

      // With default gate: HIGH finding gives REVIEW REQUIRED
      expect(engine.evaluateFindings(findings, DEFAULT_GATE_CONFIG)).toBe("REVIEW REQUIRED");

      // With tightened gate blockOn: HIGH
      const tightenedGate = { blockOn: "HIGH" as const, reviewOn: "MEDIUM" as const };
      expect(engine.evaluateFindings(findings, tightenedGate)).toBe("BLOCKED");
    });

    it("Case 2: Happy path: relax - one MEDIUM finding with reviewOn: HIGH gives PASS", () => {
      const findings = [makeFinding("VULNERABILITY", "MEDIUM")];

      // With default gate: MEDIUM finding gives REVIEW REQUIRED
      expect(engine.evaluateFindings(findings, DEFAULT_GATE_CONFIG)).toBe("REVIEW REQUIRED");

      // With relaxed gate reviewOn: HIGH (and blockOn: CRITICAL)
      const relaxedGate = { blockOn: "CRITICAL" as const, reviewOn: "HIGH" as const };
      expect(engine.evaluateFindings(findings, relaxedGate)).toBe("PASS");
    });

    it("Case 2b: Override - type override for SECRET blocks at MEDIUM while VULNERABILITY passes review", () => {
      const gateWithOverride = {
        blockOn: "CRITICAL" as const,
        reviewOn: "HIGH" as const,
        overrides: [{ type: "SECRET", blockOn: "MEDIUM" as const }],
      };

      const secretFinding = [makeFinding("SECRET", "MEDIUM")];
      const vulnFinding = [makeFinding("VULNERABILITY", "MEDIUM")];

      expect(engine.evaluateFindings(secretFinding, gateWithOverride)).toBe("BLOCKED");
      expect(engine.evaluateFindings(vulnFinding, gateWithOverride)).toBe("PASS");
    });

    it("Case 3: Defaults apply when config file is missing (404)", async () => {
      const client = {
        rest: {
          repos: {
            getContent: vi
              .fn()
              .mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
          },
          pulls: {
            get: vi.fn().mockResolvedValue({ data: { base: { ref: "main" } } }),
          },
        },
      };

      const config = await loadTrustedGateConfig(client as any, {
        owner: "acme",
        repo: "repo",
        prNumber: 10,
        baseRef: "main",
      });

      expect(config).toEqual(DEFAULT_GATE_CONFIG);
      expect(isDefaultGate(config)).toBe(true);
      expect(formatGateSummaryLine(config)).toBeNull();
    });

    it("Case 4: Bad config - 500 API error or bad JSON logs warning and resolves to default gate", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      const client = {
        rest: {
          repos: {
            getContent: vi.fn().mockRejectedValue(new Error("Internal Server Error (500)")),
          },
          pulls: {
            get: vi.fn().mockResolvedValue({ data: { base: { ref: "main" } } }),
          },
        },
      };

      const config = await loadTrustedGateConfig(client as any, {
        owner: "acme",
        repo: "repo",
        prNumber: 10,
        baseRef: "main",
      });

      expect(config).toEqual(DEFAULT_GATE_CONFIG);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Could not read ${SECUREFLOW_CONFIG_FILE}`),
      );
    });

    it("Case 5: Tampering - file is fetched exclusively from base branch, never from head", async () => {
      const getContentMock = vi.fn().mockResolvedValue({
        data: {
          content: base64(JSON.stringify({ gate: { blockOn: "HIGH" } })),
        },
      });

      const client = {
        rest: {
          repos: { getContent: getContentMock },
          pulls: {
            get: vi.fn().mockResolvedValue({ data: { base: { ref: "production" } } }),
          },
        },
      };

      const config = await loadTrustedGateConfig(client as any, {
        owner: "org",
        repo: "core",
        prNumber: 42,
        baseRef: "production",
      });

      expect(config.blockOn).toBe("HIGH");
      expect(getContentMock).toHaveBeenCalledWith({
        owner: "org",
        repo: "core",
        path: SECUREFLOW_CONFIG_FILE,
        ref: "production",
      });
      // Verified ref is baseRef 'production', never any head ref
    });

    it("Case 6: Consistency - uninterpretable severity yields REVIEW REQUIRED regardless of gate", () => {
      const gateRelaxed = { blockOn: "CRITICAL" as const, reviewOn: "CRITICAL" as const };
      const unparseableFinding = [makeFinding("VULNERABILITY", "UNKNOWN_SEV_XYZ")];

      expect(engine.evaluateFindings(unparseableFinding, gateRelaxed)).toBe("REVIEW REQUIRED");
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", null)], gateRelaxed)).toBe(
        "REVIEW REQUIRED",
      );
    });

    it("Case 7: Regression - single argument evaluateFindings(findings) returns baseline results", () => {
      expect(engine.evaluateFindings([])).toBe("PASS");
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "CRITICAL")])).toBe("BLOCKED");
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "HIGH")])).toBe(
        "REVIEW REQUIRED",
      );
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "MEDIUM")])).toBe(
        "REVIEW REQUIRED",
      );
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "LOW")])).toBe("PASS");
    });
  });

  describe("confidence configuration and blocking opt-in (#1924)", () => {
    it("parses minCommentConfidence from confidence object", () => {
      const json = JSON.stringify({
        confidence: {
          minCommentConfidence: "HIGH",
          filterBlocking: true,
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.minCommentConfidence).toBe("HIGH");
      expect(config.filterBlocking).toBe(true);
    });

    it("parses minCommentConfidence from root or aliases", () => {
      const json = JSON.stringify({
        minConfidence: "low",
      });

      const config = parseSecureFlowConfig(json);
      expect(config.minCommentConfidence).toBe("LOW");
      expect(config.filterBlocking).toBe(false);
    });

    it("warns and falls back to default when minCommentConfidence is invalid", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const json = JSON.stringify({
        confidence: {
          minCommentConfidence: "INVALID_CONFIDENCE_LEVEL",
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.minCommentConfidence).toBe("MEDIUM");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown minCommentConfidence 'INVALID_CONFIDENCE_LEVEL'"),
      );
    });

    it("blocking behavior is unchanged by default with low confidence findings", () => {
      // By default (filterBlocking is false/unset), a CRITICAL finding blocks even with LOW confidence
      const findingWithLowConf: ScanFinding = {
        type: "Secret",
        severity: "CRITICAL",
        confidence: "LOW",
        fileLocation: "src/test.ts",
        description: "Uncertain secret",
        codeSnippet: "key = 1",
      };

      const result = engine.evaluateFindings([findingWithLowConf], {
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        minCommentConfidence: "HIGH",
        filterBlocking: false,
      });

      expect(result).toBe("BLOCKED");
    });

    it("blocking behavior respects confidence filter when explicitly opted in", () => {
      // When filterBlocking: true, finding with LOW confidence is filtered out of blocking evaluation
      const findingWithLowConf: ScanFinding = {
        type: "Secret",
        severity: "CRITICAL",
        confidence: "LOW",
        fileLocation: "src/test.ts",
        description: "Uncertain secret",
        codeSnippet: "key = 1",
      };

      const result = engine.evaluateFindings([findingWithLowConf], {
        blockOn: "CRITICAL",
        reviewOn: "MEDIUM",
        minCommentConfidence: "MEDIUM",
        filterBlocking: true,
      });

      expect(result).toBe("PASS");
    });
  });

  describe("default ignore pattern overrides (#1983)", () => {
    it("parses includeDefaults and forceInclude at root level", () => {
      const json = JSON.stringify({
        includeDefaults: false,
        forceInclude: ["vendor/**", "dist/custom.js"],
      });

      const config = parseSecureFlowConfig(json);
      expect(config.includeDefaults).toBe(false);
      expect(config.forceInclude).toEqual(["vendor/**", "dist/custom.js"]);
      expect(isDefaultGate(config)).toBe(false);
    });

    it("parses includeDefaults and forceInclude within gate block", () => {
      const json = JSON.stringify({
        gate: {
          blockOn: "CRITICAL",
          reviewOn: "MEDIUM",
          includeDefaults: false,
          forceInclude: ["*.min.js"],
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.includeDefaults).toBe(false);
      expect(config.forceInclude).toEqual(["*.min.js"]);
    });

    it("parses includeDefaults and forceInclude within ignore block", () => {
      const json = JSON.stringify({
        ignore: {
          includeDefaults: false,
          forceInclude: ["client/openapi/**"],
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.includeDefaults).toBe(false);
      expect(config.forceInclude).toEqual(["client/openapi/**"]);
    });

    it("treats default config as default gate when no overrides exist", () => {
      const config = parseSecureFlowConfig("{}");
      expect(config.includeDefaults).toBeUndefined();
      expect(config.forceInclude).toBeUndefined();
      expect(isDefaultGate(config)).toBe(true);
    });

    it("parses timeoutBudget and requestTimeout from gate section (#1981)", () => {
      const json = JSON.stringify({
        gate: {
          timeoutBudget: 90,
          requestTimeout: 45,
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.timeoutBudget).toBe(90);
      expect(config.requestTimeout).toBe(45);
      expect(isDefaultGate(config)).toBe(false);
      expect(resolveScanTimeoutBudgetMs(config)).toBe(90_000);
      expect(resolveScanRequestTimeoutMs(config)).toBe(45_000);
    });

    it("parses timeout aliases and scanner block (#1981)", () => {
      const json = JSON.stringify({
        scanner: {
          timeoutBudgetSeconds: 150,
          requestTimeoutSeconds: 30,
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.timeoutBudget).toBe(150);
      expect(config.requestTimeout).toBe(30);
      expect(resolveScanTimeoutBudgetMs(config)).toBe(150_000);
      expect(resolveScanRequestTimeoutMs(config)).toBe(30_000);
    });

    it("ignores invalid timeout values (<= 0 or non-number) and uses defaults (#1981)", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const json = JSON.stringify({
        gate: {
          timeoutBudget: -10,
          requestTimeout: "fast",
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.timeoutBudget).toBeUndefined();
      expect(config.requestTimeout).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("positive integer"));
      expect(resolveScanTimeoutBudgetMs(config)).toBe(DEFAULT_SCAN_TIMEOUT_BUDGET_SECONDS * 1000);
      expect(resolveScanRequestTimeoutMs(config)).toBe(DEFAULT_SCAN_REQUEST_TIMEOUT_SECONDS * 1000);
    });
  });

  describe("skipDrafts and skipAuthors (#1982)", () => {
    it("parses skipDrafts and skipAuthors at root level", () => {
      const json = JSON.stringify({
        skipDrafts: true,
        skipAuthors: ["dependabot[bot]", "renovate[bot]", "*bot*"],
      });

      const config = parseSecureFlowConfig(json);
      expect(config.skipDrafts).toBe(true);
      expect(config.skipAuthors).toEqual(["dependabot[bot]", "renovate[bot]", "*bot*"]);
      expect(isDefaultGate(config)).toBe(false);
    });

    it("parses skipDrafts and skipAuthors within gate block", () => {
      const json = JSON.stringify({
        gate: {
          blockOn: "CRITICAL",
          reviewOn: "MEDIUM",
          skipDrafts: true,
          skipAuthors: ["release-bot"],
        },
      });

      const config = parseSecureFlowConfig(json);
      expect(config.skipDrafts).toBe(true);
      expect(config.skipAuthors).toEqual(["release-bot"]);
      expect(isDefaultGate(config)).toBe(false);
    });

    it("safely ignores non-boolean skipDrafts with a warning", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const json = JSON.stringify({
        skipDrafts: "yes",
      });

      const config = parseSecureFlowConfig(json);
      expect(config.skipDrafts).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown skipDrafts value"));
    });

    it("safely ignores non-array skipAuthors with a warning", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const json = JSON.stringify({
        skipAuthors: "dependabot[bot]",
      });

      const config = parseSecureFlowConfig(json);
      expect(config.skipAuthors).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid skipAuthors value"));
    });

    it("filters out invalid entries in skipAuthors with warnings", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const json = JSON.stringify({
        skipAuthors: ["dependabot[bot]", 123, null, "  "],
      });

      const config = parseSecureFlowConfig(json);
      expect(config.skipAuthors).toEqual(["dependabot[bot]"]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid skipAuthors entry"));
    });

    it("considers false skipDrafts and empty skipAuthors as default gate", () => {
      const json = JSON.stringify({
        skipDrafts: false,
        skipAuthors: [],
      });

      const config = parseSecureFlowConfig(json);
      expect(config.skipDrafts).toBe(false);
      expect(config.skipAuthors).toBeUndefined();
      expect(isDefaultGate(config)).toBe(true);
    });
  });

  describe("isAuthorSkipped matching helper (#1982)", () => {
    it("returns false for null, undefined, or empty author/patterns", () => {
      expect(isAuthorSkipped(null, ["dependabot[bot]"])).toBe(false);
      expect(isAuthorSkipped(undefined, ["dependabot[bot]"])).toBe(false);
      expect(isAuthorSkipped("alice", null)).toBe(false);
      expect(isAuthorSkipped("alice", undefined)).toBe(false);
      expect(isAuthorSkipped("alice", [])).toBe(false);
    });

    it("matches exact logins case-insensitively", () => {
      const patterns = ["dependabot[bot]", "Renovate[bot]"];
      expect(isAuthorSkipped("dependabot[bot]", patterns)).toBe(true);
      expect(isAuthorSkipped("DEPENDABOT[BOT]", patterns)).toBe(true);
      expect(isAuthorSkipped("renovate[bot]", patterns)).toBe(true);
      expect(isAuthorSkipped("RENOVATE[BOT]", patterns)).toBe(true);
      expect(isAuthorSkipped("alice", patterns)).toBe(false);
    });

    it("matches wildcard glob patterns", () => {
      const patterns = ["*bot*", "release-*", "app-?.service"];
      expect(isAuthorSkipped("github-actions[bot]", patterns)).toBe(true);
      expect(isAuthorSkipped("my-custom-bot", patterns)).toBe(true);
      expect(isAuthorSkipped("release-v1.0", patterns)).toBe(true);
      expect(isAuthorSkipped("app-1.service", patterns)).toBe(true);
      expect(isAuthorSkipped("developer-bob", patterns)).toBe(false);
    });

    it("safely handles patterns with regex special characters", () => {
      const patterns = ["bot+service", "user(special)", "corp[team]"];
      expect(isAuthorSkipped("bot+service", patterns)).toBe(true);
      expect(isAuthorSkipped("user(special)", patterns)).toBe(true);
      expect(isAuthorSkipped("corp[team]", patterns)).toBe(true);
      expect(isAuthorSkipped("botservice", patterns)).toBe(false);
    });
  });

  describe("verifyCritical configuration (#2007)", () => {
    beforeEach(() => {
      vi.unstubAllEnvs();
    });

    it("resolves default verifyCritical (false) when unconfigured", () => {
      expect(resolveVerifyCritical()).toBe(false);
      expect(resolveVerifyCritical(null)).toBe(false);
      expect(resolveVerifyCritical({})).toBe(false);
    });

    it("resolves verifyCritical from environment variable", () => {
      vi.stubEnv("VERIFY_CRITICAL_FINDINGS", "true");
      expect(resolveVerifyCritical()).toBe(true);

      vi.stubEnv("VERIFY_CRITICAL_FINDINGS", "false");
      expect(resolveVerifyCritical()).toBe(false);
    });

    it("resolves verifyCritical from object config", () => {
      expect(resolveVerifyCritical({ verifyCritical: true })).toBe(true);
      expect(resolveVerifyCritical({ verifyCriticalFindings: true })).toBe(true);
      expect(resolveVerifyCritical({ gate: { verifyCritical: true } })).toBe(true);
      expect(resolveVerifyCritical({ scanner: { verifyCritical: true } })).toBe(true);
    });

    it("resolves default maxVerificationCalls (5) when unconfigured", () => {
      expect(resolveMaxVerificationCalls()).toBe(DEFAULT_MAX_VERIFICATION_CALLS);
      expect(resolveMaxVerificationCalls(null)).toBe(5);
      expect(resolveMaxVerificationCalls({})).toBe(5);
    });

    it("resolves maxVerificationCalls from environment variable", () => {
      vi.stubEnv("MAX_VERIFICATION_CALLS", "8");
      expect(resolveMaxVerificationCalls()).toBe(8);
    });

    it("resolves valid configured integer value", () => {
      expect(resolveMaxVerificationCalls(3)).toBe(3);
      expect(resolveMaxVerificationCalls("7")).toBe(7);
      expect(resolveMaxVerificationCalls({ maxVerificationCalls: 10 })).toBe(10);
      expect(resolveMaxVerificationCalls({ gate: { maxVerificationCalls: 4 } })).toBe(4);
    });

    it("caps values at MAX_VERIFICATION_CALLS_LIMIT (20)", () => {
      expect(resolveMaxVerificationCalls(25)).toBe(MAX_VERIFICATION_CALLS_LIMIT);
      expect(resolveMaxVerificationCalls(100)).toBe(20);
    });

    it("falls back to default (5) on invalid input with a warning", () => {
      const warnSpy = vi.spyOn(console, "warn");
      expect(resolveMaxVerificationCalls("invalid")).toBe(5);
      expect(resolveMaxVerificationCalls(-3)).toBe(5);
      expect(resolveMaxVerificationCalls(0)).toBe(5);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid maxVerificationCalls value"),
      );
    });

    it("parses verifyCritical and maxVerificationCalls from .secureflow.json", () => {
      const json = JSON.stringify({
        verifyCritical: true,
        maxVerificationCalls: 7,
      });
      const parsed = parseSecureFlowConfig(json);
      expect(parsed.verifyCritical).toBe(true);
      expect(parsed.maxVerificationCalls).toBe(7);
      expect(isDefaultGate(parsed)).toBe(false);
    });

    it("formats gate summary line with critical verification notice", () => {
      const summary = formatGateSummaryLine({
        blockOn: "CRITICAL",
        reviewOn: "HIGH",
        verifyCritical: true,
      });
      expect(summary).toContain("critical verification on");
    });
  });
});
