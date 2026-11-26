import { API_TOKEN_SCOPES } from "./api-token-types";

/**
 * Hierarchical API Token Scope Attenuation & Resource-Bound Permission Enforcement (#2175).
 */

export class ScopeEscalationError extends Error {
  readonly disallowedScopes: string[];

  constructor(disallowedScopes: string[]) {
    super(`Scope escalation denied for requested scope(s): ${disallowedScopes.join(", ")}`);
    this.name = "ScopeEscalationError";
    this.disallowedScopes = disallowedScopes;
  }
}

export interface ResourceContext {
  repository?: string;
}

export interface ParsedScope {
  repositoryPattern: string | null;
  baseScope: string;
}

const SCOPE_IMPLICATIONS: Record<string, readonly string[]> = {
  "findings:write": ["findings:read"],
  "scans:write": ["scans:read"],
  "policies:write": ["policies:read"],
  "findings:*": ["findings:write", "findings:read"],
  "scans:*": ["scans:write", "scans:read"],
  "policies:*": ["policies:write", "policies:read"],
  "audit:*": ["audit:read"],
  "admin:*": [...API_TOKEN_SCOPES],
};

/**
 * Parses a global scope (`findings:read`) or repository-bound scope (`repo:owner/name:findings:read`).
 */
export function parseResourceScope(scope: string): ParsedScope {
  const trimmed = scope.trim();
  if (trimmed.startsWith("repo:")) {
    const firstColon = trimmed.indexOf(":", 5);
    if (firstColon > 5) {
      return {
        repositoryPattern: trimmed.slice(5, firstColon),
        baseScope: trimmed.slice(firstColon + 1),
      };
    }
  }
  return {
    repositoryPattern: null,
    baseScope: trimmed,
  };
}

function repoMatches(pattern: string, targetRepo: string): boolean {
  const p = pattern.toLowerCase();
  const t = targetRepo.toLowerCase();
  if (p === t || p === "*") return true;
  if (p.endsWith("/*")) {
    const prefix = p.slice(0, -1); // "owner/"
    return t.startsWith(prefix);
  }
  return false;
}

/**
 * Computes the transitive closure of a base scope under the permission lattice.
 */
export function expandBaseScope(baseScope: string): Set<string> {
  const result = new Set<string>([baseScope]);
  const queue = [baseScope];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const implied = SCOPE_IMPLICATIONS[current] ?? [];
    for (const child of implied) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }

  return result;
}

/**
 * Expands all global scopes into their effective flattened permission set.
 */
export function expandEffectiveScopes(scopes: readonly string[]): Set<string> {
  const effective = new Set<string>();
  for (const s of scopes) {
    const parsed = parseResourceScope(s);
    if (parsed.repositoryPattern === null) {
      for (const imp of expandBaseScope(parsed.baseScope)) {
        effective.add(imp);
      }
    }
  }
  return effective;
}

/**
 * Checks whether `grantedScopes` satisfies `requiredScope` under optional `resourceContext`.
 */
export function hasRequiredScope(
  grantedScopes: readonly string[],
  requiredScope: string,
  resourceContext?: ResourceContext,
): boolean {
  const req = parseResourceScope(requiredScope);

  for (const rawGranted of grantedScopes) {
    const granted = parseResourceScope(rawGranted);
    const expanded = expandBaseScope(granted.baseScope);
    if (!expanded.has(req.baseScope)) {
      continue;
    }

    // Global grant satisfies both global and repo-scoped requirements
    if (granted.repositoryPattern === null) {
      return true;
    }

    // Repo-scoped grant requires a matching target repository
    const targetRepo = req.repositoryPattern ?? resourceContext?.repository;
    if (targetRepo && repoMatches(granted.repositoryPattern, targetRepo)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the subset of `requiredScopes` not satisfied by `grantedScopes`.
 */
export function findMissingScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
  resourceContext?: ResourceContext,
): string[] {
  return requiredScopes.filter((req) => !hasRequiredScope(grantedScopes, req, resourceContext));
}

/**
 * Monotonically attenuates `requestedScopes` against `parentScopes`, guaranteeing
 * a delegated token can never escalate beyond its parent's effective permissions.
 */
export function attenuateScopes(
  parentScopes: readonly string[],
  requestedScopes: readonly string[],
  options: { strict?: boolean } = {},
): string[] {
  const allowed: string[] = [];
  const disallowed: string[] = [];

  for (const rawReq of requestedScopes) {
    const req = parseResourceScope(rawReq);
    const parentAllows = parentScopes.some((rawParent) => {
      const parent = parseResourceScope(rawParent);
      const expanded = expandBaseScope(parent.baseScope);
      if (!expanded.has(req.baseScope)) {
        return false;
      }
      // Global parent can narrow to any global or repo-scoped child
      if (parent.repositoryPattern === null) {
        return true;
      }
      // Repo-scoped parent cannot widen to global child, and must cover child's repo pattern
      if (req.repositoryPattern === null) {
        return false;
      }
      return repoMatches(parent.repositoryPattern, req.repositoryPattern);
    });

    if (parentAllows) {
      if (!allowed.includes(rawReq)) {
        allowed.push(rawReq);
      }
    } else {
      disallowed.push(rawReq);
    }
  }

  if (options.strict && disallowed.length > 0) {
    throw new ScopeEscalationError(disallowed);
  }

  return allowed;
}
