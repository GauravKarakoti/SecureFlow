import { describe, it, expect } from "vitest";
import {
  resolveEffectiveSettings,
  buildEffectiveGateConfig,
  isSeverityWeaker,
  isConfidenceWeaker,
  type InstallationSettingsDto,
} from "./installation-settings";
import type { GateConfig } from "./gate-config";

describe("Installation Settings & Hierarchical Resolution Engine (#2010)", () => {
  describe("isSeverityWeaker", () => {
    it("correctly identifies when candidate severity weakens baseline", () => {
      // Baseline CRITICAL: HIGH, MEDIUM, LOW, NONE weaken it
      expect(isSeverityWeaker("HIGH", "CRITICAL")).toBe(true);
      expect(isSeverityWeaker("MEDIUM", "CRITICAL")).toBe(true);
      expect(isSeverityWeaker("LOW", "CRITICAL")).toBe(true);
      expect(isSeverityWeaker("NONE", "CRITICAL")).toBe(true);
      expect(isSeverityWeaker("CRITICAL", "CRITICAL")).toBe(false);

      // Baseline HIGH: MEDIUM, LOW, NONE weaken it; CRITICAL tightens it
      expect(isSeverityWeaker("MEDIUM", "HIGH")).toBe(true);
      expect(isSeverityWeaker("CRITICAL", "HIGH")).toBe(false);

      // Baseline MEDIUM: LOW, NONE weaken it; CRITICAL, HIGH tighten it
      expect(isSeverityWeaker("LOW", "MEDIUM")).toBe(true);
      expect(isSeverityWeaker("HIGH", "MEDIUM")).toBe(false);
      expect(isSeverityWeaker("CRITICAL", "MEDIUM")).toBe(false);
    });
  });

  describe("isConfidenceWeaker", () => {
    it("correctly identifies when candidate confidence threshold weakens baseline", () => {
      // Baseline HIGH: MEDIUM, LOW weaken it
      expect(isConfidenceWeaker("MEDIUM", "HIGH")).toBe(true);
      expect(isConfidenceWeaker("LOW", "HIGH")).toBe(true);
      expect(isConfidenceWeaker("HIGH", "HIGH")).toBe(false);

      // Baseline MEDIUM: LOW weakens it; HIGH tightens it
      expect(isConfidenceWeaker("LOW", "MEDIUM")).toBe(true);
      expect(isConfidenceWeaker("HIGH", "MEDIUM")).toBe(false);
      expect(isConfidenceWeaker("MEDIUM", "MEDIUM")).toBe(false);
    });
  });

  describe("Resolution order (Built-in -> Installation -> Repository)", () => {
    it("inherits built-in defaults when both installation and repository set nothing", () => {
      const resolved = resolveEffectiveSettings(null, null);

      expect(resolved.gateBlockOn).toEqual({
        value: "CRITICAL",
        source: "built-in",
        isLocked: false,
      });
      expect(resolved.gateReviewOn).toEqual({
        value: "MEDIUM",
        source: "built-in",
        isLocked: false,
      });
      expect(resolved.minCommentConfidence).toEqual({
        value: "MEDIUM",
        source: "built-in",
        isLocked: false,
      });
      expect(resolved.includeDefaults).toEqual({
        value: true,
        source: "built-in",
        isLocked: false,
      });
      expect(resolved.skipDrafts).toEqual({
        value: false,
        source: "built-in",
        isLocked: false,
      });
      expect(resolved.skipAuthors).toEqual({
        value: [],
        source: "built-in",
        isLocked: false,
      });
    });

    it("inherits installation baseline defaults when repository sets nothing", () => {
      const installationSettings: InstallationSettingsDto = {
        gateBlockOn: "HIGH",
        gateReviewOn: "LOW",
        minCommentConfidence: "HIGH",
        includeDefaults: false,
        skipDrafts: true,
        skipAuthors: ["renovate[bot]", "dependabot[bot]"],
        lockedSettings: [],
      };

      const resolved = resolveEffectiveSettings({}, installationSettings);

      expect(resolved.gateBlockOn).toEqual({
        value: "HIGH",
        source: "installation",
        isLocked: false,
      });
      expect(resolved.gateReviewOn).toEqual({
        value: "LOW",
        source: "installation",
        isLocked: false,
      });
      expect(resolved.minCommentConfidence).toEqual({
        value: "HIGH",
        source: "installation",
        isLocked: false,
      });
      expect(resolved.includeDefaults).toEqual({
        value: false,
        source: "installation",
        isLocked: false,
      });
      expect(resolved.skipDrafts).toEqual({
        value: true,
        source: "installation",
        isLocked: false,
      });
      expect(resolved.skipAuthors).toEqual({
        value: ["renovate[bot]", "dependabot[bot]"],
        source: "installation",
        isLocked: false,
      });
    });

    it("allows repository .secureflow.json to override unlocked installation settings", () => {
      const installationSettings: InstallationSettingsDto = {
        gateBlockOn: "CRITICAL",
        gateReviewOn: "MEDIUM",
        minCommentConfidence: "HIGH",
        includeDefaults: true,
        skipDrafts: false,
        skipAuthors: ["bot-install"],
        lockedSettings: [], // Nothing locked
      };

      const repoConfig: Partial<GateConfig> = {
        blockOn: "HIGH",
        reviewOn: "LOW",
        minCommentConfidence: "LOW",
        includeDefaults: false,
        skipDrafts: true,
        skipAuthors: ["custom-bot"],
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.gateBlockOn).toEqual({
        value: "HIGH",
        source: "repository",
        isLocked: false,
      });
      expect(resolved.gateReviewOn).toEqual({
        value: "LOW",
        source: "repository",
        isLocked: false,
      });
      expect(resolved.minCommentConfidence).toEqual({
        value: "LOW",
        source: "repository",
        isLocked: false,
      });
      expect(resolved.includeDefaults).toEqual({
        value: false,
        source: "repository",
        isLocked: false,
      });
      expect(resolved.skipDrafts).toEqual({
        value: true,
        source: "repository",
        isLocked: false,
      });
      expect(resolved.skipAuthors).toEqual({
        value: ["custom-bot"],
        source: "repository",
        isLocked: false,
      });
    });
  });

  describe("Locking and Baseline Enforcement", () => {
    it("prevents repository from weakening locked gateBlockOn", () => {
      const installationSettings: InstallationSettingsDto = {
        gateBlockOn: "CRITICAL",
        lockedSettings: ["gateBlockOn"],
      };

      // Repo tries to weaken to HIGH
      const repoConfig: Partial<GateConfig> = {
        blockOn: "HIGH",
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.gateBlockOn).toEqual({
        value: "CRITICAL",
        source: "installation",
        isLocked: true,
      });
    });

    it("allows repository to strengthen/tighten locked gateBlockOn", () => {
      const installationSettings: InstallationSettingsDto = {
        gateBlockOn: "HIGH",
        lockedSettings: ["gateBlockOn"],
      };

      // Repo tightens to CRITICAL
      const repoConfig: Partial<GateConfig> = {
        blockOn: "CRITICAL",
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.gateBlockOn).toEqual({
        value: "CRITICAL",
        source: "repository",
        isLocked: true,
      });
    });

    it("prevents repository from weakening locked minCommentConfidence", () => {
      const installationSettings: InstallationSettingsDto = {
        minCommentConfidence: "MEDIUM",
        lockedSettings: ["minCommentConfidence"],
      };

      // Repo tries to weaken to LOW
      const repoConfig: Partial<GateConfig> = {
        minCommentConfidence: "LOW",
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.minCommentConfidence).toEqual({
        value: "MEDIUM",
        source: "installation",
        isLocked: true,
      });
    });

    it("allows repository to strengthen locked minCommentConfidence", () => {
      const installationSettings: InstallationSettingsDto = {
        minCommentConfidence: "MEDIUM",
        lockedSettings: ["minCommentConfidence"],
      };

      // Repo tightens to HIGH
      const repoConfig: Partial<GateConfig> = {
        minCommentConfidence: "HIGH",
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.minCommentConfidence).toEqual({
        value: "HIGH",
        source: "repository",
        isLocked: true,
      });
    });

    it("prevents repository from disabling locked includeDefaults baseline", () => {
      const installationSettings: InstallationSettingsDto = {
        includeDefaults: true,
        lockedSettings: ["includeDefaults"],
      };

      const repoConfig: Partial<GateConfig> = {
        includeDefaults: false,
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.includeDefaults).toEqual({
        value: true,
        source: "installation",
        isLocked: true,
      });
    });

    it("prevents repository from overriding locked skipDrafts", () => {
      const installationSettings: InstallationSettingsDto = {
        skipDrafts: false,
        lockedSettings: ["skipDrafts"],
      };

      const repoConfig: Partial<GateConfig> = {
        skipDrafts: true,
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.skipDrafts).toEqual({
        value: false,
        source: "installation",
        isLocked: true,
      });
    });

    it("prevents repository from overriding locked skipAuthors", () => {
      const installationSettings: InstallationSettingsDto = {
        skipAuthors: ["admin-bot"],
        lockedSettings: ["skipAuthors"],
      };

      const repoConfig: Partial<GateConfig> = {
        skipAuthors: ["repo-bot"],
      };

      const resolved = resolveEffectiveSettings(repoConfig, installationSettings);

      expect(resolved.skipAuthors).toEqual({
        value: ["admin-bot"],
        source: "installation",
        isLocked: true,
      });
    });
  });

  describe("buildEffectiveGateConfig", () => {
    it("produces complete GateConfig with resolved settings and non-locked repo options", () => {
      const installationSettings: InstallationSettingsDto = {
        gateBlockOn: "CRITICAL",
        gateReviewOn: "HIGH",
        lockedSettings: ["gateBlockOn"],
      };

      const repoConfig: GateConfig = {
        blockOn: "LOW", // Will be rejected because gateBlockOn is locked
        reviewOn: "LOW", // Unlocked, so repository value will take effect
        timeoutBudget: 60,
        policyScopes: [{ paths: ["src/backend/**"] }],
      };

      const effective = buildEffectiveGateConfig(repoConfig, installationSettings);

      expect(effective.blockOn).toBe("CRITICAL"); // Locked baseline
      expect(effective.reviewOn).toBe("LOW"); // Repo override
      expect(effective.timeoutBudget).toBe(60); // Repo option preserved
      expect(effective.policyScopes).toEqual([{ paths: ["src/backend/**"] }]);
    });
  });
});
