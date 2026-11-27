import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_POLLUTION_RULE_IDS,
  scanChangedFileForPrototypePollution,
  scanSourceForPrototypePollution,
} from "./prototype-pollution-rules";
import { runPatternSecurityRules } from "./pattern-rules";

describe("Prototype Pollution & Unsafe Merge Rules (CWE-1321)", () => {
  it("detects direct __proto__, constructor.prototype, and Object.prototype sinks", () => {
    const source = [
      "const obj: any = {};",
      "obj.__proto__.isAdmin = true;",
      "obj.constructor.prototype.role = 'admin';",
      "Object.prototype['polluted'] = 1;",
    ].join("\n");

    const findings = scanSourceForPrototypePollution(source, "src/utils/merge.ts");
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.ruleId === PROTOTYPE_POLLUTION_RULE_IDS.DIRECT_PROTO_SINK)).toBe(
      true,
    );
    expect(findings.every((f) => f.severity === "CRITICAL" && f.cwe === "CWE-1321")).toBe(true);
  });

  it("detects unguarded dynamic assignment and unsafe Object.assign", () => {
    const source = [
      "function unsafeMerge(target: any, source: any) {",
      "  for (const key in source) {",
      "    target[key] = source[key];",
      "  }",
      "  Object.assign(target, req.body);",
      "}",
    ].join("\n");

    const findings = scanSourceForPrototypePollution(source, "src/api/settings.ts");
    expect(findings).toHaveLength(2);
    expect(findings[0].ruleId).toBe(PROTOTYPE_POLLUTION_RULE_IDS.UNGUARDED_DYNAMIC_ASSIGN);
    expect(findings[1].ruleId).toBe(PROTOTYPE_POLLUTION_RULE_IDS.UNSAFE_OBJECT_ASSIGN);
  });

  it("avoids false positives when __proto__ blocklist or Object.hasOwn guards are present", () => {
    const guarded = [
      "function safeMerge(target: Record<string, unknown>, source: Record<string, unknown>) {",
      "  for (const key of Object.keys(source)) {",
      "    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;",
      "    if (!Object.hasOwn(source, key)) continue;",
      "    target[key] = source[key];",
      "  }",
      "}",
    ].join("\n");

    const findings = scanSourceForPrototypePollution(guarded, "src/utils/safe-merge.ts");
    expect(findings).toEqual([]);
  });

  it("integrates with runPatternSecurityRules on unified diffs", () => {
    const patch = [
      "@@ -1,2 +1,4 @@",
      " const config: any = {};",
      "+function merge(dst: any, src: any) {",
      "+  for (const k in src) { dst[k] = src[k]; }",
      "+}",
    ].join("\n");

    const directDiffFindings = scanChangedFileForPrototypePollution({
      filename: "src/merge.ts",
      status: "modified",
      patch,
    });
    expect(directDiffFindings).toHaveLength(1);
    expect(directDiffFindings[0].matchedSignatures).toContain("CWE-1321");

    const viaPatternRules = runPatternSecurityRules([
      { filename: "src/merge.ts", status: "modified", patch },
    ]);
    expect(viaPatternRules.some((f) => f.type === "Prototype Pollution")).toBe(true);
  });
});
