import { describe, it, expect } from "vitest";
import {
  expandEffectiveScopes,
  hasRequiredScope,
  findMissingScopes,
  attenuateScopes,
  ScopeEscalationError,
} from "./scope-attenuation";
import { API_TOKEN_SCOPES } from "./api-token-types";

describe("Hierarchical API Token Scope Attenuation & Resource Isolation (#2175)", () => {
  it("expands write and wildcard scopes hierarchically to implied read scopes", () => {
    const expanded = expandEffectiveScopes(["findings:write", "policies:write"]);
    expect(expanded.has("findings:write")).toBe(true);
    expect(expanded.has("findings:read")).toBe(true);
    expect(expanded.has("policies:write")).toBe(true);
    expect(expanded.has("policies:read")).toBe(true);
    expect(expanded.has("scans:read")).toBe(false);

    const adminExpanded = expandEffectiveScopes(["admin:*"]);
    for (const s of API_TOKEN_SCOPES) {
      expect(adminExpanded.has(s)).toBe(true);
    }
  });

  it("enforces monotonic attenuation and throws ScopeEscalationError in strict mode", () => {
    const parent = ["findings:read", "scans:write"];

    // Clamping mode drops disallowed escalations
    const clamped = attenuateScopes(parent, [
      "findings:read",
      "findings:write",
      "scans:read",
      "audit:read",
    ]);
    expect(clamped).toEqual(["findings:read", "scans:read"]);

    // Strict mode throws on privilege escalation
    expect(() => attenuateScopes(parent, ["findings:write"], { strict: true })).toThrowError(
      ScopeEscalationError,
    );
  });

  it("allows narrowing global scopes to repo-scoped child tokens, but forbids widening", () => {
    const globalParent = ["findings:write"];
    const narrowed = attenuateScopes(globalParent, ["repo:acme/billing:findings:read"], {
      strict: true,
    });
    expect(narrowed).toEqual(["repo:acme/billing:findings:read"]);

    const repoParent = ["repo:acme/billing:findings:write"];
    // Widening to global scope must fail
    expect(() => attenuateScopes(repoParent, ["findings:read"], { strict: true })).toThrowError(
      ScopeEscalationError,
    );

    // Moving to a different repository must fail
    expect(() =>
      attenuateScopes(repoParent, ["repo:acme/other:findings:read"], { strict: true }),
    ).toThrowError(ScopeEscalationError);
  });

  it("enforces repository-bound permission isolation in hasRequiredScope and findMissingScopes", () => {
    const tokenScopes = ["repo:acme/api:scans:write", "repo:partner/*:findings:read"];

    expect(hasRequiredScope(tokenScopes, "scans:read", { repository: "acme/api" })).toBe(true);
    expect(hasRequiredScope(tokenScopes, "scans:write", { repository: "acme/api" })).toBe(true);
    expect(hasRequiredScope(tokenScopes, "scans:read", { repository: "acme/web" })).toBe(false);
    expect(hasRequiredScope(tokenScopes, "scans:read")).toBe(false);

    expect(hasRequiredScope(tokenScopes, "findings:read", { repository: "partner/sdk" })).toBe(
      true,
    );
    expect(hasRequiredScope(tokenScopes, "findings:write", { repository: "partner/sdk" })).toBe(
      false,
    );

    expect(
      findMissingScopes(tokenScopes, ["scans:read", "audit:read"], { repository: "acme/api" }),
    ).toEqual(["audit:read"]);
  });
});
