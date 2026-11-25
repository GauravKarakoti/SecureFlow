import { describe, it, expect } from "vitest";
import {
  detectPolicyCycle,
  resolvePolicyDependencyGraph,
  PolicyCycleError,
  type PolicyGraphNode,
} from "./dependency-graph";
import { validatePolicyImportPayload } from "./export-import";
import { evaluateCompliancePolicies } from "./compliance-engine";

describe("Policy DAG Cycle Detector & Topological Resolver (#2071)", () => {
  it("detects self-referential circular dependency (A -> A)", () => {
    const nodes: PolicyGraphNode[] = [{ id: "A", dependsOn: ["A"] }];

    const cycle = detectPolicyCycle(nodes);
    expect(cycle).toEqual(["A", "A"]);

    const res = resolvePolicyDependencyGraph(nodes);
    expect(res.valid).toBe(false);
    expect(res.cyclePath).toEqual(["A", "A"]);
    expect(res.error).toContain("Circular policy dependency detected: A -> A");
  });

  it("detects direct circular dependency (A -> B -> A)", () => {
    const nodes: PolicyGraphNode[] = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];

    const res = resolvePolicyDependencyGraph(nodes);
    expect(res.valid).toBe(false);
    expect(res.cyclePath).toEqual(["A", "B", "A"]);
    expect(res.error).toBe("Circular policy dependency detected: A -> B -> A");
  });

  it("detects deep transitive circular dependency (A -> B -> C -> D -> A)", () => {
    const nodes: PolicyGraphNode[] = [
      { id: "root", dependsOn: ["A"] },
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["C"] },
      { id: "C", dependsOn: ["D"] },
      { id: "D", dependsOn: ["A"] },
    ];

    const cycle = detectPolicyCycle(nodes);
    expect(cycle).toEqual(["A", "B", "C", "D", "A"]);

    expect(() => resolvePolicyDependencyGraph(nodes, { throwOnCycle: true })).toThrowError(
      PolicyCycleError,
    );
  });

  it("topologically orders multi-branch diamond DAG so prerequisites always precede dependents", () => {
    const nodes: PolicyGraphNode[] = [
      { id: "app-policy", dependsOn: ["soc2-secrets", "hipaa-encryption"] },
      { id: "soc2-secrets", dependsOn: ["base-auth"] },
      { id: "hipaa-encryption", dependsOn: ["base-auth"] },
      { id: "base-auth", dependsOn: [] },
    ];

    const res = resolvePolicyDependencyGraph(nodes);
    expect(res.valid).toBe(true);
    expect(res.cyclePath).toBeNull();
    expect(res.missingDependencies).toEqual([]);

    const indexById = new Map(res.ordered.map((n, idx) => [n.id, idx]));
    expect(indexById.get("base-auth")!).toBeLessThan(indexById.get("soc2-secrets")!);
    expect(indexById.get("base-auth")!).toBeLessThan(indexById.get("hipaa-encryption")!);
    expect(indexById.get("soc2-secrets")!).toBeLessThan(indexById.get("app-policy")!);
    expect(indexById.get("hipaa-encryption")!).toBeLessThan(indexById.get("app-policy")!);
  });

  it("handles disconnected subgraphs cleanly in topological order", () => {
    const nodes: PolicyGraphNode[] = [
      { id: "child-1", dependsOn: ["parent-1"] },
      { id: "parent-1" },
      { id: "standalone" },
      { id: "child-2", dependsOn: ["parent-2"] },
      { id: "parent-2" },
    ];

    const res = resolvePolicyDependencyGraph(nodes);
    expect(res.valid).toBe(true);
    expect(res.ordered).toHaveLength(5);

    const indexById = new Map(res.ordered.map((n, idx) => [n.id, idx]));
    expect(indexById.get("parent-1")!).toBeLessThan(indexById.get("child-1")!);
    expect(indexById.get("parent-2")!).toBeLessThan(indexById.get("child-2")!);
  });

  it("reports missing prerequisite dependencies when strictMissingDeps is enabled", () => {
    const nodes: PolicyGraphNode[] = [{ id: "policy-x", dependsOn: ["non-existent-base"] }];

    const nonStrict = resolvePolicyDependencyGraph(nodes);
    expect(nonStrict.valid).toBe(true);
    expect(nonStrict.missingDependencies).toEqual([
      { policyId: "policy-x", missingId: "non-existent-base" },
    ]);

    const strict = resolvePolicyDependencyGraph(nodes, { strictMissingDeps: true });
    expect(strict.valid).toBe(false);
    expect(strict.error).toContain("policy-x -> non-existent-base");
  });

  it("integrates with validatePolicyImportPayload to reject cyclic bundles and sort valid ones", () => {
    const cyclicBundle = {
      version: "1.0",
      policies: [
        {
          name: "Policy A",
          description: "Depends on B",
          severity: "HIGH",
          enabled: true,
          dependsOn: ["Policy B"],
        },
        {
          name: "Policy B",
          description: "Depends on A",
          severity: "HIGH",
          enabled: true,
          dependsOn: ["Policy A"],
        },
      ],
    };

    const invalidResult = validatePolicyImportPayload(cyclicBundle);
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.error).toContain(
      "Circular policy dependency detected: Policy A -> Policy B -> Policy A",
    );

    const validBundle = {
      version: "1.0",
      policies: [
        {
          name: "Child Policy",
          description: "Runs after Base Policy",
          severity: "MEDIUM",
          enabled: true,
          dependsOn: ["Base Policy"],
        },
        {
          name: "Base Policy",
          description: "Prerequisite policy",
          severity: "HIGH",
          enabled: true,
          dependsOn: [],
        },
      ],
    };

    const validResult = validatePolicyImportPayload(validBundle);
    expect(validResult.success).toBe(true);
    expect(validResult.data?.policies.map((p) => p.name)).toEqual(["Base Policy", "Child Policy"]);
  });

  it("integrates with evaluateCompliancePolicies to guard against cyclic pack graphs", () => {
    const cyclicPacks: any[] = [
      {
        id: "pack-1",
        name: "Pack 1",
        rules: {},
        complianceTags: [],
        dependsOn: ["pack-2"],
      },
      {
        id: "pack-2",
        name: "Pack 2",
        rules: {},
        complianceTags: [],
        dependsOn: ["pack-1"],
      },
    ];

    expect(() => evaluateCompliancePolicies([], cyclicPacks)).toThrowError(PolicyCycleError);
  });
});
