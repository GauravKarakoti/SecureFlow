import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseSecureFlowConfig,
  formatGateSummaryLine,
  isDefaultGate,
  loadTrustedGateConfig,
  loadBaseGateConfig,
  DEFAULT_GATE_CONFIG,
  SECUREFLOW_CONFIG_FILE,
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
            getContent: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
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
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "HIGH")])).toBe("REVIEW REQUIRED");
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "MEDIUM")])).toBe("REVIEW REQUIRED");
      expect(engine.evaluateFindings([makeFinding("VULNERABILITY", "LOW")])).toBe("PASS");
    });
  });
});
