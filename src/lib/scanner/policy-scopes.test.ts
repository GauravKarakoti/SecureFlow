import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectAppliedScopes,
  formatAppliedScopesSection,
  groupFilesByPolicyScope,
  isValidGlob,
  parsePolicyScopes,
  resolvePoliciesForFile,
  type PolicyScopeRule,
} from "./policy-scopes";
import { formatGateSummaryLine, isDefaultGate, parseSecureFlowConfig } from "./gate-config";

describe("Monorepo Policy Scopes (#1868)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("isValidGlob", () => {
    it("returns true for standard glob patterns", () => {
      expect(isValidGlob("src/**")).toBe(true);
      expect(isValidGlob("terraform/*.tf")).toBe(true);
      expect(isValidGlob("*.ts")).toBe(true);
      expect(isValidGlob("tests/**/fixtures/*")).toBe(true);
    });

    it("returns false for non-string, empty, or whitespace patterns", () => {
      expect(isValidGlob(null)).toBe(false);
      expect(isValidGlob(undefined)).toBe(false);
      expect(isValidGlob(123)).toBe(false);
      expect(isValidGlob("")).toBe(false);
      expect(isValidGlob("   ")).toBe(false);
    });
  });

  describe("parsePolicyScopes", () => {
    it("returns empty scopes with no warning when raw is null or undefined", () => {
      expect(parsePolicyScopes(undefined)).toEqual({ scopes: [], warnings: [] });
      expect(parsePolicyScopes(null)).toEqual({ scopes: [], warnings: [] });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns and returns empty scopes when raw is not an array", () => {
      const res = parsePolicyScopes({ paths: ["src/**"] });
      expect(res.scopes).toEqual([]);
      expect(res.warnings.length).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("parses valid scopes in definition order", () => {
      const raw = [
        {
          paths: ["terraform/**", "*.tf"],
          enable: ["infrastructure-security", "secrets"],
        },
        {
          paths: ["tests/**"],
          disable: ["production-secrets"],
        },
      ];

      const res = parsePolicyScopes(raw);
      expect(res.scopes).toEqual([
        {
          paths: ["terraform/**", "*.tf"],
          enable: ["infrastructure-security", "secrets"],
        },
        {
          paths: ["tests/**"],
          disable: ["production-secrets"],
        },
      ]);
      expect(res.warnings).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("skips non-object or malformed entries with a warning", () => {
      const raw = [
        "not an object",
        null,
        { paths: [] }, // empty paths
        { paths: ["src/**"] }, // neither enable nor disable
        { paths: ["src/**"], enable: ["xss"] }, // valid
      ];

      const res = parsePolicyScopes(raw);
      expect(res.scopes).toHaveLength(1);
      expect(res.scopes[0]).toEqual({
        paths: ["src/**"],
        enable: ["xss"],
      });
      expect(res.warnings.length).toBeGreaterThanOrEqual(4);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("filters invalid globs in paths and ignores unknown policy names with warnings", () => {
      const raw = [
        {
          paths: ["", 123, "valid/**"],
          enable: ["KnownPolicy", "UnknownPolicy"],
        },
      ];

      const known = ["KnownPolicy", "OtherPolicy"];
      const res = parsePolicyScopes(raw, known);

      expect(res.scopes).toEqual([
        {
          paths: ["valid/**"],
          enable: ["KnownPolicy"],
        },
      ]);
      expect(res.warnings.some((w) => w.includes("UnknownPolicy"))).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("skips scope if all globs are invalid or all policy names are unknown", () => {
      const raw = [
        {
          paths: ["src/**"],
          enable: ["UnknownPolicy"],
        },
      ];

      const res = parsePolicyScopes(raw, ["KnownPolicy"]);
      expect(res.scopes).toEqual([]);
      expect(res.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("resolvePoliciesForFile", () => {
    const allPolicies = [
      { id: "1", name: "No Hardcoded Secrets", description: "Detect secrets" },
      { id: "2", name: "Terraform Security", description: "Infra policies" },
      { id: "3", name: "Cross-Site Scripting (XSS)", description: "Frontend XSS" },
      { id: "4", name: "SQL Injection", description: "Backend SQLi" },
    ];

    it("returns all active policies when no policyScopes are defined", () => {
      const result = resolvePoliciesForFile("src/app.ts", allPolicies, undefined);
      expect(result.policies).toHaveLength(4);
      expect(result.appliedScopes).toHaveLength(0);
    });

    it("returns all active policies when file does not match any scope", () => {
      const scopes: PolicyScopeRule[] = [
        { paths: ["terraform/**"], enable: ["Terraform Security"] },
      ];
      const result = resolvePoliciesForFile("src/app.ts", allPolicies, scopes);
      expect(result.policies).toHaveLength(4);
      expect(result.appliedScopes).toHaveLength(0);
    });

    it("applies enable rule restricting to only specified policies (case-insensitive)", () => {
      const scopes: PolicyScopeRule[] = [
        { paths: ["terraform/**"], enable: ["terraform security"] },
      ];
      const result = resolvePoliciesForFile("terraform/main.tf", allPolicies, scopes);
      expect(result.policies).toHaveLength(1);
      expect(result.policies[0].name).toBe("Terraform Security");
      expect(result.appliedScopes).toHaveLength(1);
    });

    it("applies disable rule excluding specified policies", () => {
      const scopes: PolicyScopeRule[] = [
        { paths: ["tests/**"], disable: ["No Hardcoded Secrets"] },
      ];
      const result = resolvePoliciesForFile("tests/unit.test.ts", allPolicies, scopes);
      expect(result.policies).toHaveLength(3);
      expect(result.policies.map((p) => p.name)).not.toContain("No Hardcoded Secrets");
      expect(result.appliedScopes).toHaveLength(1);
    });

    it("resolves conflicting scopes in definition order", () => {
      // First scope enables Terraform Security and Secrets
      // Second scope disables Secrets
      const scopes: PolicyScopeRule[] = [
        {
          paths: ["infra/**"],
          enable: ["Terraform Security", "No Hardcoded Secrets"],
        },
        {
          paths: ["infra/dev/**"],
          disable: ["No Hardcoded Secrets"],
        },
      ];

      // File in infra/prod matches only first scope
      const prodResult = resolvePoliciesForFile("infra/prod/main.tf", allPolicies, scopes);
      expect(prodResult.policies).toHaveLength(2);
      expect(prodResult.policies.map((p) => p.name)).toEqual([
        "No Hardcoded Secrets",
        "Terraform Security",
      ]);

      // File in infra/dev matches both scopes in order
      const devResult = resolvePoliciesForFile("infra/dev/main.tf", allPolicies, scopes);
      expect(devResult.policies).toHaveLength(1);
      expect(devResult.policies[0].name).toBe("Terraform Security");
      expect(devResult.appliedScopes).toHaveLength(2);
    });

    it("handles scope with both enable and disable", () => {
      const scopes: PolicyScopeRule[] = [
        {
          paths: ["src/**"],
          enable: ["SQL Injection", "Cross-Site Scripting (XSS)"],
          disable: ["SQL Injection"],
        },
      ];
      const result = resolvePoliciesForFile("src/index.ts", allPolicies, scopes);
      expect(result.policies).toHaveLength(1);
      expect(result.policies[0].name).toBe("Cross-Site Scripting (XSS)");
    });
  });

  describe("groupFilesByPolicyScope", () => {
    const policies = [
      { id: "1", name: "Secrets" },
      { id: "2", name: "Terraform" },
      { id: "3", name: "XSS" },
    ];

    it("returns single default group when no scopes are defined", () => {
      const files = [{ filename: "a.tf" }, { filename: "b.ts" }];
      const groups = groupFilesByPolicyScope(files, policies);
      expect(groups).toHaveLength(1);
      expect(groups[0].files).toHaveLength(2);
      expect(groups[0].policies).toHaveLength(3);
    });

    it("groups files by applicable policy sets", () => {
      const files = [
        { filename: "infra/main.tf" },
        { filename: "infra/variables.tf" },
        { filename: "src/app.tsx" },
        { filename: "README.md" },
      ];

      const scopes: PolicyScopeRule[] = [
        { paths: ["infra/**"], enable: ["Terraform"] },
        { paths: ["src/**"], enable: ["XSS"] },
      ];

      const groups = groupFilesByPolicyScope(files, policies, scopes);
      expect(groups).toHaveLength(3);

      const terraformGroup = groups.find((g) => g.policies.some((p) => p.name === "Terraform"));
      expect(terraformGroup?.files.map((f) => f.filename)).toEqual([
        "infra/main.tf",
        "infra/variables.tf",
      ]);

      const xssGroup = groups.find((g) => g.policies.some((p) => p.name === "XSS"));
      expect(xssGroup?.files.map((f) => f.filename)).toEqual(["src/app.tsx"]);

      const defaultGroup = groups.find((g) => g.policies.length === 3);
      expect(defaultGroup?.files.map((f) => f.filename)).toEqual(["README.md"]);
    });
  });

  describe("collectAppliedScopes & formatAppliedScopesSection", () => {
    it("collects only scopes that matched changed files", () => {
      const files = [{ filename: "terraform/vpc.tf" }, { filename: "src/button.tsx" }];
      const scopes: PolicyScopeRule[] = [
        { paths: ["terraform/**"], enable: ["Terraform Security"] },
        { paths: ["tests/**"], disable: ["Secrets"] }, // Unmatched
      ];

      const applied = collectAppliedScopes(files, scopes);
      expect(applied).toHaveLength(1);
      expect(applied[0].scope.paths).toEqual(["terraform/**"]);
      expect(applied[0].matchedFiles).toEqual(["terraform/vpc.tf"]);
    });

    it("formats markdown applied scopes section correctly", () => {
      const applied = [
        {
          scope: { paths: ["terraform/**", "*.tf"], enable: ["Terraform Security"] },
          matchedFiles: ["terraform/main.tf", "terraform/vars.tf"],
        },
      ];

      const markdown = formatAppliedScopesSection(applied);
      expect(markdown).toContain("### 📁 Policy Scopes Applied (1)");
      expect(markdown).toContain("`terraform/**`, `*.tf`");
      expect(markdown).toContain("Enabled **Terraform Security**");
      expect(markdown).toContain("(2 files)");
    });

    it("returns empty string if no scopes were applied", () => {
      expect(formatAppliedScopesSection([])).toBe("");
    });
  });

  describe(".secureflow.json integration", () => {
    it("parses policyScopes in parseSecureFlowConfig at root or gate level", () => {
      const config1 = parseSecureFlowConfig(
        JSON.stringify({
          policyScopes: [{ paths: ["terraform/**"], enable: ["Terraform Security"] }],
        }),
      );
      expect(config1.policyScopes).toHaveLength(1);
      expect(isDefaultGate(config1)).toBe(false);

      const config2 = parseSecureFlowConfig(
        JSON.stringify({
          gate: {
            policyScopes: [{ paths: ["tests/**"], disable: ["Secrets"] }],
          },
        }),
      );
      expect(config2.policyScopes).toHaveLength(1);
      expect(isDefaultGate(config2)).toBe(false);
    });

    it("formats gate summary line with policy scopes indicator", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          policyScopes: [{ paths: ["terraform/**"], enable: ["Terraform Security"] }],
        }),
      );
      const summary = formatGateSummaryLine(config);
      expect(summary).toContain("1 policy scope active");
    });

    it("ignores malformed policyScopes without failing parseSecureFlowConfig", () => {
      const config = parseSecureFlowConfig(
        JSON.stringify({
          policyScopes: "not an array",
        }),
      );
      expect(config.policyScopes).toBeUndefined();
      expect(isDefaultGate(config)).toBe(true);
    });
  });
});
