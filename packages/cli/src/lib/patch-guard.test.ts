import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PatchGuard,
  PatchBoundaryViolationError,
  PatchRateLimitExceededError,
  PatchLoopDetectedError,
} from "./patch-guard.js";
import { generateRemediationPatch } from "./api-client.js";

describe("secureflow-cli PatchGuard (Rate Limiter, Boundaries & Loop Prevention)", () => {
  let guard: PatchGuard;

  beforeEach(() => {
    guard = new PatchGuard({
      maxPerResourceInWindow: 3,
      maxGlobalInWindow: 6,
      windowMs: 60_000,
      maxPatchSizeBytes: 1024,
      maxPatchLines: 10,
      maxIdenticalRepeats: 3,
      maxOscillations: 3,
    });
  });

  describe("Boundary Constraints", () => {
    it("rejects path traversal attempts", () => {
      expect(() => guard.validateResourcePath("../../../etc/shadow")).toThrow(
        PatchBoundaryViolationError,
      );

      expect(() => guard.validateResourcePath("src/../../secret.ts")).toThrow(
        PatchBoundaryViolationError,
      );
    });

    it("rejects sensitive files and credential paths", () => {
      expect(() => guard.validateResourcePath(".env")).toThrow(PatchBoundaryViolationError);
      expect(() => guard.validateResourcePath("config/.env.local")).toThrow(
        PatchBoundaryViolationError,
      );
      expect(() => guard.validateResourcePath(".git/config")).toThrow(PatchBoundaryViolationError);
      expect(() => guard.validateResourcePath(".ssh/id_rsa")).toThrow(PatchBoundaryViolationError);
    });

    it("accepts valid project relative paths", () => {
      expect(() => guard.validateResourcePath("src/components/button.tsx")).not.toThrow();
      expect(() => guard.validateResourcePath("infra/helm/values.yaml")).not.toThrow();
    });

    it("enforces patch byte size limits", () => {
      const smallDiff = "--- a/file\n+++ b/file\n";
      expect(() => guard.validatePatchDiff("src/file.ts", smallDiff)).not.toThrow();

      const largeDiff = "a".repeat(1025);
      expect(() => guard.validatePatchDiff("src/file.ts", largeDiff)).toThrow(
        PatchBoundaryViolationError,
      );
    });

    it("enforces patch line count limits", () => {
      const manyLinesDiff = Array(15).fill("+ line").join("\n");
      expect(() => guard.validatePatchDiff("src/file.ts", manyLinesDiff)).toThrow(
        PatchBoundaryViolationError,
      );
    });
  });

  describe("Rate-Limiting Logic", () => {
    it("allows actions up to the per-resource limit and blocks subsequent ones", () => {
      const resource = "src/api/auth.ts";
      const now = 100000;

      // 3 attempts are allowed
      for (let i = 0; i < 3; i++) {
        expect(() => guard.assertCanApply({ resource, now })).not.toThrow();
        guard.recordAction({ resource, now, patchDiff: `diff-${i}` });
      }

      // 4th attempt exceeds limit
      expect(() => guard.assertCanApply({ resource, now })).toThrow(PatchRateLimitExceededError);
    });

    it("enforces global rate limits across different resources", () => {
      const now = 100000;

      // Apply 2 actions across 3 different resources (total 6)
      for (let r = 0; r < 3; r++) {
        for (let i = 0; i < 2; i++) {
          const res = `src/res-${r}.ts`;
          guard.recordAction({ resource: res, now, patchDiff: `diff-${r}-${i}` });
        }
      }

      // Global limit is 6, any new resource should now be rate limited
      expect(() => guard.assertCanApply({ resource: "src/new-resource.ts", now })).toThrow(
        PatchRateLimitExceededError,
      );
    });

    it("allows new actions after window expires (sliding window)", () => {
      const resource = "src/api/auth.ts";
      const now = 100000;

      for (let i = 0; i < 3; i++) {
        guard.recordAction({ resource, now, patchDiff: `diff-${i}` });
      }

      // Blocked at now + 10s
      expect(() => guard.assertCanApply({ resource, now: now + 10_000 })).toThrow(
        PatchRateLimitExceededError,
      );

      // Allowed after window expires at now + 61s
      expect(() => guard.assertCanApply({ resource, now: now + 61_000 })).not.toThrow();
    });
  });

  describe("Loop and Oscillation Protection", () => {
    it("blocks identical patches looped repeatedly on the same resource", () => {
      const resource = "infra/k8s/deployment.yaml";
      const sameDiff = "--- a/k8s.yaml\n+++ b/k8s.yaml\n+ replicas: 0\n";
      const now = 100000;

      guard.recordAction({ resource, patchDiff: sameDiff, now });
      guard.recordAction({ resource, patchDiff: sameDiff, now: now + 1000 });

      // 3rd attempt with identical patch trips loop protection
      expect(() =>
        guard.assertCanApply({ resource, patchDiff: sameDiff, now: now + 2000 }),
      ).toThrow(PatchLoopDetectedError);
    });

    it("detects and blocks oscillating patch loops", () => {
      const resource = "src/config.ts";
      const diffA = "+ state: A\n";
      const diffB = "+ state: B\n";
      const now = 100000;

      // History: A -> B -> A
      guard.recordAction({ resource, patchDiff: diffA, now });
      guard.recordAction({ resource, patchDiff: diffB, now: now + 1000 });
      guard.recordAction({ resource, patchDiff: diffA, now: now + 2000 });

      // Next action is B again -> oscillation loop detected!
      expect(() => guard.assertCanApply({ resource, patchDiff: diffB, now: now + 3000 })).toThrow(
        PatchLoopDetectedError,
      );
    });
  });

  describe("Integration with generateRemediationPatch", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("intercepts boundary violations before making network requests", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(
        generateRemediationPatch("finding-123", {
          targetResource: "../../etc/shadow",
          patchGuard: guard,
        }),
      ).rejects.toThrow(PatchBoundaryViolationError);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("records returned patch diff and validates response constraints", async () => {
      const mockPatch = {
        id: "patch-1",
        findingId: "finding-123",
        patchDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n",
        status: "GENERATED",
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          patch: mockPatch,
        }),
      } as any);

      const res = await generateRemediationPatch("finding-123", {
        targetResource: "src/app.ts",
        patchGuard: guard,
      });

      expect(res.success).toBe(true);
      expect(res.patch?.patchDiff).toBe(mockPatch.patchDiff);
    });
  });
});
