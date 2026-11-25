/**
 * Directed Acyclic Graph (DAG) cycle detector and topological dependency resolver
 * for SecureFlow security policies and compliance packs (#2071).
 */

export interface PolicyGraphNode {
  id: string;
  dependsOn?: readonly string[] | undefined;
}

export class PolicyCycleError extends Error {
  readonly cyclePath: string[];

  constructor(cyclePath: string[]) {
    super(`Circular policy dependency detected: ${cyclePath.join(" -> ")}`);
    this.name = "PolicyCycleError";
    this.cyclePath = cyclePath;
  }
}

export interface MissingPolicyDependency {
  policyId: string;
  missingId: string;
}

export interface DependencyResolutionResult<T extends PolicyGraphNode> {
  valid: boolean;
  ordered: T[];
  cyclePath: string[] | null;
  missingDependencies: MissingPolicyDependency[];
  error?: string;
}

export interface ResolveDependencyOptions {
  throwOnCycle?: boolean;
  strictMissingDeps?: boolean;
}

const UNVISITED = 0;
const VISITING = 1;
const VISITED = 2;

/**
 * Detects circular dependencies across a set of policy nodes using 3-color DFS.
 * Returns the exact cycle sequence (e.g. ["A", "B", "C", "A"]) if a cycle exists,
 * or null if the graph is acyclic.
 */
export function detectPolicyCycle<T extends PolicyGraphNode>(nodes: readonly T[]): string[] | null {
  const adj = new Map<string, readonly string[]>();
  for (const node of nodes) {
    adj.set(node.id, node.dependsOn ?? []);
  }

  const state = new Map<string, number>();
  const stack: string[] = [];

  function dfs(nodeId: string): string[] | null {
    state.set(nodeId, VISITING);
    stack.push(nodeId);

    const deps = adj.get(nodeId) ?? [];
    for (const depId of deps) {
      const depState = state.get(depId) ?? UNVISITED;
      if (depState === VISITING) {
        const cycleStart = stack.indexOf(depId);
        return [...stack.slice(cycleStart), depId];
      }
      if (depState === UNVISITED && adj.has(depId)) {
        const found = dfs(depId);
        if (found) return found;
      }
    }

    stack.pop();
    state.set(nodeId, VISITED);
    return null;
  }

  for (const node of nodes) {
    if ((state.get(node.id) ?? UNVISITED) === UNVISITED) {
      const cycle = dfs(node.id);
      if (cycle) return cycle;
    }
  }

  return null;
}

/**
 * Validates a policy dependency graph for cycles and resolves a deterministic
 * topological evaluation order where prerequisites always precede dependents.
 */
export function resolvePolicyDependencyGraph<T extends PolicyGraphNode>(
  nodes: readonly T[],
  options: ResolveDependencyOptions = {},
): DependencyResolutionResult<T> {
  const nodeMap = new Map<string, T>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const missingDependencies: MissingPolicyDependency[] = [];
  for (const node of nodes) {
    for (const depId of node.dependsOn ?? []) {
      if (!nodeMap.has(depId)) {
        missingDependencies.push({ policyId: node.id, missingId: depId });
      }
    }
  }

  const cyclePath = detectPolicyCycle(nodes);
  if (cyclePath) {
    const err = new PolicyCycleError(cyclePath);
    if (options.throwOnCycle) {
      throw err;
    }
    return {
      valid: false,
      ordered: [],
      cyclePath,
      missingDependencies,
      error: err.message,
    };
  }

  if (options.strictMissingDeps && missingDependencies.length > 0) {
    const details = missingDependencies.map((m) => `${m.policyId} -> ${m.missingId}`).join(", ");
    return {
      valid: false,
      ordered: [],
      cyclePath: null,
      missingDependencies,
      error: `Missing prerequisite policy dependencies: ${details}`,
    };
  }

  // Post-order DFS guarantees every prerequisite is pushed before its dependents,
  // while preserving input order for independent / disconnected nodes.
  const visited = new Set<string>();
  const ordered: T[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    for (const depId of node.dependsOn ?? []) {
      if (nodeMap.has(depId)) {
        visit(depId);
      }
    }

    ordered.push(node);
  }

  for (const node of nodes) {
    visit(node.id);
  }

  return {
    valid: true,
    ordered,
    cyclePath: null,
    missingDependencies,
  };
}
