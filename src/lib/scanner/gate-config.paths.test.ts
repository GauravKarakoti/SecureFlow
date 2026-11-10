import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatGateSummaryLine,
  isDefaultGate,
  parseSecureFlowConfig,
  type GateConfig,
} from "./gate-config";

function configWithPaths(paths: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ gate: { blockOn: "CRITICAL", ...extra, paths } });
}

describe("gate config path rules (#1557)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe("parseSecureFlowConfig", () => {
    it("parses path rules in file order", () => {
      const config = parseSecureFlowConfig(
        configWithPaths([
          { glob: "infra/**", blockOn: "MEDIUM" },
          { glob: "tests/**", blockOn: "NONE", reviewOn: "NONE" },
        ]),
      );

      expect(config.paths).toEqual([
        { glob: "infra/**", blockOn: "MEDIUM" },
        { glob: "tests/**", blockOn: "NONE", reviewOn: "NONE" },
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("accepts the blockAt / reviewAt aliases and any letter case", () => {
      const config = parseSecureFlowConfig(
        configWithPaths([{ glob: "src/**", blockAt: "high", reviewAt: "low" }]),
      );

      expect(config.paths).toEqual([{ glob: "src/**", blockOn: "HIGH", reviewOn: "LOW" }]);
    });

    it("skips a rule with a non-string glob and keeps the valid one, without throwing", () => {
      const config = parseSecureFlowConfig(
        configWithPaths([
          { glob: "infra/**", blockOn: "MEDIUM" },
          { glob: 42, blockOn: "LOW" },
        ]),
      );

      expect(config.paths).toEqual([{ glob: "infra/**", blockOn: "MEDIUM" }]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("skips rules that have no glob or are not objects", () => {
      const config = parseSecureFlowConfig(
        configWithPaths([{ blockOn: "HIGH" }, "infra/**", null, { glob: "  " }]),
      );

      expect(config.paths).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(4);
    });

    it("skips a rule with an unknown level and keeps the others", () => {
      const config = parseSecureFlowConfig(
        configWithPaths([
          { glob: "a/**", blockOn: "banana" },
          { glob: "b/**", reviewOn: "bogus" },
          { glob: "c/**", blockOn: "LOW" },
        ]),
      );

      expect(config.paths).toEqual([{ glob: "c/**", blockOn: "LOW" }]);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("ignores paths that is not an array, with a warning", () => {
      const config = parseSecureFlowConfig(configWithPaths("infra/**"));

      expect(config.paths).toBeUndefined();
      expect(config.blockOn).toBe("CRITICAL");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("falls back to the default gate for invalid JSON", () => {
      const config = parseSecureFlowConfig("{ not json");

      expect(config.blockOn).toBe("CRITICAL");
      expect(config.reviewOn).toBe("MEDIUM");
      expect(config.paths).toBeUndefined();
    });

    it("leaves a config without paths exactly as before", () => {
      const config = parseSecureFlowConfig('{"gate":{"blockOn":"HIGH"}}');

      expect(config).toEqual({ blockOn: "HIGH", reviewOn: "MEDIUM", overrides: [] });
      expect("paths" in config).toBe(false);
    });
  });

  describe("isDefaultGate", () => {
    const base: GateConfig = { blockOn: "CRITICAL", reviewOn: "MEDIUM", overrides: [] };

    it("is still true for the default gate and for one with an empty paths array", () => {
      expect(isDefaultGate(base)).toBe(true);
      expect(isDefaultGate({ ...base, paths: [] })).toBe(true);
    });

    it("is false as soon as a path rule exists", () => {
      expect(isDefaultGate({ ...base, paths: [{ glob: "infra/**", blockOn: "MEDIUM" }] })).toBe(
        false,
      );
    });
  });

  describe("formatGateSummaryLine", () => {
    const base: GateConfig = { blockOn: "CRITICAL", reviewOn: "MEDIUM", overrides: [] };

    it("stays null for the default gate", () => {
      expect(formatGateSummaryLine(base)).toBeNull();
    });

    it("mentions the number of path rules, even when the global gate is the default", () => {
      const line = formatGateSummaryLine({
        ...base,
        paths: [
          { glob: "infra/**", blockOn: "MEDIUM" },
          { glob: "tests/**", blockOn: "NONE" },
        ],
      });

      expect(line).toContain("2 path rules active");
      expect(line).toContain("from base branch");
    });

    it("uses the singular for one rule", () => {
      const line = formatGateSummaryLine({
        ...base,
        paths: [{ glob: "infra/**", blockOn: "MEDIUM" }],
      });

      expect(line).toContain("1 path rule active");
    });
  });
});
