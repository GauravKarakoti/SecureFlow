import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanFinding } from "./scanner";
import { DEFAULT_GATE_CONFIG, parseSecureFlowConfig } from "@/lib/scanner/gate-config";

// `evaluateFindings` is pure; the prisma client behind `getRiskTrend` is stubbed.
vi.mock("@/lib/prisma", () => ({
  default: { scanResult: { aggregate: vi.fn() } },
}));

const { ArmorIQPolicyEngine, normalizeGatePath } = await import("./iq");

function finding(severity: string, fileLocation: string, type = "Vulnerability"): ScanFinding {
  return {
    type,
    severity: severity as ScanFinding["severity"],
    description: "test finding",
    fileLocation,
    codeSnippet: "x()",
  };
}

const SAMPLE = JSON.stringify({
  gate: {
    blockOn: "CRITICAL",
    paths: [
      { glob: "infra/**", blockOn: "MEDIUM" },
      { glob: "tests/**", blockOn: "NONE", reviewOn: "NONE" },
    ],
  },
});

describe("path-scoped gate rules (#1557)", () => {
  const engine = new ArmorIQPolicyEngine();

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("happy path: a stricter path blocks a MEDIUM finding", () => {
    const gate = parseSecureFlowConfig(SAMPLE);
    expect(engine.evaluateFindings([finding("MEDIUM", "infra/main.tf")], gate)).toBe("BLOCKED");
  });

  it("happy path: elsewhere the default review level applies, not a block", () => {
    const gate = parseSecureFlowConfig(SAMPLE);
    expect(engine.evaluateFindings([finding("MEDIUM", "src/app.ts")], gate)).toBe(
      "REVIEW REQUIRED",
    );
  });

  it("happy path: a relaxed path passes a HIGH finding, and the finding itself is untouched", () => {
    const gate = parseSecureFlowConfig(SAMPLE);
    const findings = [finding("HIGH", "tests/auth.test.ts")];

    expect(engine.evaluateFindings(findings, gate)).toBe("PASS");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("precedence: a path rule beats a type override", () => {
    const gate = parseSecureFlowConfig(
      JSON.stringify({
        gate: {
          overrides: [{ type: "SECRET", blockOn: "LOW" }],
          paths: [{ glob: "infra/**", blockOn: "HIGH" }],
        },
      }),
    );

    expect(engine.evaluateFindings([finding("LOW", "infra/a.env", "SECRET")], gate)).toBe("PASS");
    // Outside the path the type override still applies.
    expect(engine.evaluateFindings([finding("LOW", "src/a.env", "SECRET")], gate)).toBe("BLOCKED");
  });

  it("the first matching rule that sets a key wins for that key", () => {
    const gate = parseSecureFlowConfig(
      JSON.stringify({
        gate: {
          paths: [
            { glob: "infra/**", blockOn: "HIGH" },
            { glob: "infra/**", blockOn: "LOW" },
          ],
        },
      }),
    );

    expect(engine.evaluateFindings([finding("MEDIUM", "infra/a.tf")], gate)).toBe(
      "REVIEW REQUIRED",
    );
  });

  it("a key a rule leaves unset falls through to a later rule, then to the global value", () => {
    const gate = parseSecureFlowConfig(
      JSON.stringify({
        gate: {
          paths: [
            { glob: "infra/**", reviewOn: "NONE" },
            { glob: "infra/**", blockOn: "LOW" },
            { glob: "docs/**", reviewOn: "NONE" },
          ],
        },
      }),
    );

    expect(engine.evaluateFindings([finding("LOW", "infra/a.tf")], gate)).toBe("BLOCKED");
    // docs/** only relaxes review, so the global blockOn still applies.
    expect(engine.evaluateFindings([finding("CRITICAL", "docs/a.md")], gate)).toBe("BLOCKED");
  });

  it("a glob without a slash matches at any depth", () => {
    const gate = parseSecureFlowConfig(
      JSON.stringify({ gate: { paths: [{ glob: "*.tf", blockOn: "LOW" }] } }),
    );

    expect(engine.evaluateFindings([finding("LOW", "deep/dir/main.tf")], gate)).toBe("BLOCKED");
  });

  it("edge: a bad rule is skipped and the valid one still applies, without throwing", () => {
    const gate = parseSecureFlowConfig(
      JSON.stringify({
        gate: {
          paths: [
            { glob: "infra/**", blockOn: "MEDIUM" },
            { glob: 42, blockOn: "LOW" },
          ],
        },
      }),
    );

    expect(() => engine.evaluateFindings([finding("MEDIUM", "infra/main.tf")], gate)).not.toThrow();
    expect(engine.evaluateFindings([finding("MEDIUM", "infra/main.tf")], gate)).toBe("BLOCKED");
  });

  it("edge: invalid JSON gives the default gate", () => {
    const gate = parseSecureFlowConfig("{ nope");

    expect(engine.evaluateFindings([finding("MEDIUM", "infra/main.tf")], gate)).toBe(
      "REVIEW REQUIRED",
    );
    expect(engine.evaluateFindings([finding("CRITICAL", "infra/main.tf")], gate)).toBe("BLOCKED");
  });

  it.each(["./infra/main.tf", "/infra/main.tf", "infra\\main.tf", "infra/main.tf:12"])(
    "edge: the path shape %s matches the same rule as the plain path",
    (fileLocation) => {
      const gate = parseSecureFlowConfig(SAMPLE);
      expect(engine.evaluateFindings([finding("MEDIUM", fileLocation)], gate)).toBe("BLOCKED");
    },
  );

  it("normalizeGatePath strips ./, a leading slash, backslashes and a line suffix", () => {
    expect(normalizeGatePath("./a/b.ts")).toBe("a/b.ts");
    expect(normalizeGatePath("/a/b.ts")).toBe("a/b.ts");
    expect(normalizeGatePath("a\\b.ts")).toBe("a/b.ts");
    expect(normalizeGatePath("a/b.ts:7:3")).toBe("a/b.ts");
    expect(normalizeGatePath(undefined)).toBe("");
  });

  it("regression: a config with no paths gives the same verdicts as the baseline", () => {
    const noPaths = parseSecureFlowConfig('{"gate":{"blockOn":"CRITICAL"}}');
    expect(noPaths.paths).toBeUndefined();

    for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
      const f = [finding(severity, "infra/main.tf")];
      expect(engine.evaluateFindings(f, noPaths)).toBe(engine.evaluateFindings(f));
      expect(engine.evaluateFindings(f, { ...DEFAULT_GATE_CONFIG, paths: [] })).toBe(
        engine.evaluateFindings(f),
      );
    }
  });
});
