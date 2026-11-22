import { describe, it, expect } from "vitest";
import {
  can,
  assertCan,
  getUserRole,
  PermissionDeniedError,
  ROLE_PERMISSIONS,
  type InstallationRole,
  type PermissionAction,
} from "./permissions";

describe("Permission Matrix and can() helper (#1922)", () => {
  const ALL_ACTIONS: PermissionAction[] = [
    "findings:read",
    "findings:dismiss",
    "findings:restore",
    "findings:notes",
    "findings:assign",
    "findings:remediate",
    "findings:delete",
    "analytics:read",
    "reports:read",
    "policies:read",
    "policies:edit",
    "policies:toggle",
    "suppression_rules:read",
    "suppression_rules:manage",
    "api_tokens:read",
    "api_tokens:manage",
    "settings:read",
    "settings:edit",
    "members:read",
    "members:manage",
    "audit:read",
  ];

  describe("Permission Matrix per role", () => {
    it("VIEWER has read-only access and cannot perform any mutation/triage/admin action", () => {
      const viewer = { id: "u-viewer", roles: ["VIEWER"] };

      // Allowed read actions
      expect(can(viewer, "inst-1", "findings:read")).toBe(true);
      expect(can(viewer, "inst-1", "analytics:read")).toBe(true);
      expect(can(viewer, "inst-1", "reports:read")).toBe(true);
      expect(can(viewer, "inst-1", "policies:read")).toBe(true);
      expect(can(viewer, "inst-1", "audit:read")).toBe(true);

      // Forbidden triage & write actions
      expect(can(viewer, "inst-1", "findings:dismiss")).toBe(false);
      expect(can(viewer, "inst-1", "findings:restore")).toBe(false);
      expect(can(viewer, "inst-1", "findings:notes")).toBe(false);
      expect(can(viewer, "inst-1", "findings:assign")).toBe(false);
      expect(can(viewer, "inst-1", "policies:edit")).toBe(false);
      expect(can(viewer, "inst-1", "policies:toggle")).toBe(false);
      expect(can(viewer, "inst-1", "suppression_rules:manage")).toBe(false);
      expect(can(viewer, "inst-1", "api_tokens:manage")).toBe(false);
      expect(can(viewer, "inst-1", "settings:edit")).toBe(false);
      expect(can(viewer, "inst-1", "members:manage")).toBe(false);
    });

    it("TRIAGER has all VIEWER permissions plus findings triage (dismiss, restore, notes, assign, remediate)", () => {
      const triager = { id: "u-triager", roles: ["TRIAGER"] };

      // Allowed reads
      expect(can(triager, "inst-1", "findings:read")).toBe(true);
      expect(can(triager, "inst-1", "analytics:read")).toBe(true);
      expect(can(triager, "inst-1", "reports:read")).toBe(true);
      expect(can(triager, "inst-1", "policies:read")).toBe(true);

      // Allowed triage
      expect(can(triager, "inst-1", "findings:dismiss")).toBe(true);
      expect(can(triager, "inst-1", "findings:restore")).toBe(true);
      expect(can(triager, "inst-1", "findings:notes")).toBe(true);
      expect(can(triager, "inst-1", "findings:assign")).toBe(true);
      expect(can(triager, "inst-1", "findings:remediate")).toBe(true);

      // Forbidden admin actions
      expect(can(triager, "inst-1", "policies:edit")).toBe(false);
      expect(can(triager, "inst-1", "policies:toggle")).toBe(false);
      expect(can(triager, "inst-1", "suppression_rules:manage")).toBe(false);
      expect(can(triager, "inst-1", "api_tokens:manage")).toBe(false);
      expect(can(triager, "inst-1", "settings:edit")).toBe(false);
      expect(can(triager, "inst-1", "members:manage")).toBe(false);
      expect(can(triager, "inst-1", "findings:delete")).toBe(false);
    });

    it("ADMIN has full permissions for all actions in the matrix", () => {
      const admin = { id: "u-admin", roles: ["ADMIN"] };

      for (const action of ALL_ACTIONS) {
        expect(can(admin, "inst-1", action)).toBe(true);
      }
    });

    it("Existing users (USER role) keep full access by default so existing installations do not break", () => {
      const legacyUser = { id: "u-legacy", roles: ["USER"] };

      for (const action of ALL_ACTIONS) {
        expect(can(legacyUser, "inst-1", action)).toBe(true);
      }
    });

    it("User with no explicit role defaults to USER (existing full access)", () => {
      const unspecified = { id: "u-none", roles: [] };

      expect(can(unspecified, "inst-1", "findings:read")).toBe(true);
      expect(can(unspecified, "inst-1", "findings:dismiss")).toBe(true);
      expect(can(unspecified, "inst-1", "policies:edit")).toBe(true);
    });
  });

  describe("can helper flexibility", () => {
    it("handles string roles directly", () => {
      expect(can("VIEWER", "inst-1", "findings:read")).toBe(true);
      expect(can("VIEWER", "inst-1", "findings:dismiss")).toBe(false);
      expect(can("TRIAGER", "inst-1", "findings:dismiss")).toBe(true);
      expect(can("ADMIN", "inst-1", "policies:edit")).toBe(true);
    });

    it("returns false for null, undefined, or empty user", () => {
      expect(can(null, "inst-1", "findings:read")).toBe(false);
      expect(can(undefined, "inst-1", "findings:read")).toBe(false);
    });
  });

  describe("assertCan", () => {
    it("does not throw when permission is granted", () => {
      expect(() => assertCan("TRIAGER", "inst-1", "findings:dismiss")).not.toThrow();
      expect(() => assertCan("ADMIN", "inst-1", "settings:edit")).not.toThrow();
    });

    it("throws PermissionDeniedError when permission is denied", () => {
      expect(() => assertCan("VIEWER", "inst-1", "findings:dismiss")).toThrow(
        PermissionDeniedError,
      );
      expect(() => assertCan("TRIAGER", "inst-1", "policies:edit")).toThrow(
        PermissionDeniedError,
      );
    });
  });
});
