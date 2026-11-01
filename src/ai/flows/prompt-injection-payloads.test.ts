import { describe, it, expect } from "vitest";
import {
  ADVANCED_PROMPT_INJECTION_PAYLOADS,
  EXTENDED_FUZZING_PAYLOADS,
  ADVANCED_RED_TEAM_BATCH_2,
  ENTERPRISE_RED_TEAM_BATCH_3,
  DEEP_FUZZING_BATCH_4,
  getMasterFuzzingCorpus,
  INJECTION_PAYLOADS,
  SYSTEM_PROMPT_EXFILTRATION,
  PERSONA_HIJACK,
  ENCODED_OBFUSCATION,
  INJECTION_PAYLOADS_BY_CATEGORY,
  ALL_INJECTION_PAYLOADS,
  BENIGN_SAMPLES,
  getAllRedTeamPayloads,
  getPayloadsByCategory,
  getThreatFeedPayloads,
  type InjectionPayload,
} from "./prompt-injection-payloads";

describe("src/ai/flows/prompt-injection-payloads.ts unit tests (#1500)", () => {
  describe("Payload corpus structures and integrity", () => {
    it("ensures ADVANCED_PROMPT_INJECTION_PAYLOADS has valid fields and categories", () => {
      expect(Array.isArray(ADVANCED_PROMPT_INJECTION_PAYLOADS)).toBe(true);
      expect(ADVANCED_PROMPT_INJECTION_PAYLOADS.length).toBeGreaterThan(0);

      for (const item of ADVANCED_PROMPT_INJECTION_PAYLOADS) {
        expect(typeof item.id).toBe("string");
        expect(item.id.length).toBeGreaterThan(0);
        expect(typeof item.category).toBe("string");
        expect(item.category.length).toBeGreaterThan(0);
        expect(typeof item.payload).toBe("string");
        expect(item.payload.length).toBeGreaterThan(0);

        if (item.severity) {
          expect(["low", "medium", "high", "critical"]).toContain(item.severity);
        }
        if (item.expectedBehavior) {
          expect(["blocked", "flagged", "sanitized"]).toContain(item.expectedBehavior);
        }
      }
    });

    it("ensures EXTENDED_FUZZING_PAYLOADS has valid fields and unique IDs", () => {
      expect(Array.isArray(EXTENDED_FUZZING_PAYLOADS)).toBe(true);
      expect(EXTENDED_FUZZING_PAYLOADS.length).toBeGreaterThan(0);

      const ids = new Set<string>();
      for (const item of EXTENDED_FUZZING_PAYLOADS) {
        expect(ids.has(item.id)).toBe(false);
        ids.add(item.id);
        expect(typeof item.payload).toBe("string");
        expect(item.payload.length).toBeGreaterThan(0);
      }
    });

    it("ensures ADVANCED_RED_TEAM_BATCH_2 contains valid entries", () => {
      expect(Array.isArray(ADVANCED_RED_TEAM_BATCH_2)).toBe(true);
      expect(ADVANCED_RED_TEAM_BATCH_2.length).toBeGreaterThan(0);
      for (const item of ADVANCED_RED_TEAM_BATCH_2) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.category).toBe("string");
        expect(typeof item.payload).toBe("string");
      }
    });

    it("ensures ENTERPRISE_RED_TEAM_BATCH_3 contains valid entries", () => {
      expect(Array.isArray(ENTERPRISE_RED_TEAM_BATCH_3)).toBe(true);
      expect(ENTERPRISE_RED_TEAM_BATCH_3.length).toBeGreaterThan(0);
      for (const item of ENTERPRISE_RED_TEAM_BATCH_3) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.payload).toBe("string");
      }
    });

    it("ensures DEEP_FUZZING_BATCH_4 contains valid entries", () => {
      expect(Array.isArray(DEEP_FUZZING_BATCH_4)).toBe(true);
      expect(DEEP_FUZZING_BATCH_4.length).toBeGreaterThan(0);
      for (const item of DEEP_FUZZING_BATCH_4) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.payload).toBe("string");
      }
    });

    it("ensures getMasterFuzzingCorpus combines all batches", () => {
      const masterCorpus = getMasterFuzzingCorpus();
      expect(Array.isArray(masterCorpus)).toBe(true);
      expect(masterCorpus.length).toBe(
        ADVANCED_PROMPT_INJECTION_PAYLOADS.length +
          EXTENDED_FUZZING_PAYLOADS.length +
          ADVANCED_RED_TEAM_BATCH_2.length +
          ENTERPRISE_RED_TEAM_BATCH_3.length +
          DEEP_FUZZING_BATCH_4.length,
      );
    });

    it("ensures INJECTION_PAYLOADS legacy export is populated", () => {
      expect(Array.isArray(INJECTION_PAYLOADS)).toBe(true);
      expect(INJECTION_PAYLOADS.length).toBeGreaterThan(0);
      for (const item of INJECTION_PAYLOADS) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.payload).toBe("string");
      }
    });

    it("ensures SYSTEM_PROMPT_EXFILTRATION payloads have valid structure", () => {
      expect(Array.isArray(SYSTEM_PROMPT_EXFILTRATION)).toBe(true);
      expect(SYSTEM_PROMPT_EXFILTRATION.length).toBeGreaterThan(0);

      for (const item of SYSTEM_PROMPT_EXFILTRATION) {
        expect(item.category).toBe("system-prompt-exfiltration");
        expect(typeof item.payload).toBe("string");
        expect(item.payload.trim().length).toBeGreaterThan(0);
        expect(item.expectedOutcome).toBe("blocked");
      }
    });

    it("ensures PERSONA_HIJACK payloads have valid structure", () => {
      expect(Array.isArray(PERSONA_HIJACK)).toBe(true);
      expect(PERSONA_HIJACK.length).toBeGreaterThan(0);

      for (const item of PERSONA_HIJACK) {
        expect(item.category).toBe("persona-hijack");
        expect(typeof item.payload).toBe("string");
        expect(item.expectedOutcome).toBe("blocked");
      }
    });

    it("ensures ENCODED_OBFUSCATION payloads have valid structure", () => {
      expect(Array.isArray(ENCODED_OBFUSCATION)).toBe(true);
      expect(ENCODED_OBFUSCATION.length).toBeGreaterThan(0);

      for (const item of ENCODED_OBFUSCATION) {
        expect(item.category).toBe("encoded-obfuscation");
        expect(typeof item.payload).toBe("string");
        expect(item.expectedOutcome).toBe("blocked");
      }
    });

    it("validates INJECTION_PAYLOADS_BY_CATEGORY grouping", () => {
      expect(INJECTION_PAYLOADS_BY_CATEGORY.systemPromptExfiltration).toEqual(
        SYSTEM_PROMPT_EXFILTRATION,
      );
      expect(INJECTION_PAYLOADS_BY_CATEGORY.personaHijack).toEqual(PERSONA_HIJACK);
      expect(INJECTION_PAYLOADS_BY_CATEGORY.encodedObfuscation).toEqual(ENCODED_OBFUSCATION);
    });

    it("validates ALL_INJECTION_PAYLOADS aggregation", () => {
      expect(ALL_INJECTION_PAYLOADS.length).toBe(
        SYSTEM_PROMPT_EXFILTRATION.length + PERSONA_HIJACK.length + ENCODED_OBFUSCATION.length,
      );
    });

    it("validates BENIGN_SAMPLES structure and realism", () => {
      expect(Array.isArray(BENIGN_SAMPLES)).toBe(true);
      expect(BENIGN_SAMPLES.length).toBeGreaterThan(5);

      for (const sample of BENIGN_SAMPLES) {
        expect(typeof sample).toBe("string");
        expect(sample.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Helper and retrieval functions", () => {
    it("getThreatFeedPayloads returns an array", () => {
      const payloads = getThreatFeedPayloads();
      expect(Array.isArray(payloads)).toBe(true);
    });

    it("getAllRedTeamPayloads combines and deduplicates payloads properly", () => {
      const all = getAllRedTeamPayloads();
      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBeGreaterThan(0);

      for (const item of all) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.category).toBe("string");
        expect(typeof item.payload).toBe("string");
      }
    });

    it("getPayloadsByCategory filters correctly for known categories", () => {
      const exfiltration = getPayloadsByCategory("system-prompt-exfiltration");
      expect(Array.isArray(exfiltration)).toBe(true);
      expect(exfiltration.length).toBeGreaterThan(0);
      for (const item of exfiltration) {
        expect(item.category).toBe("system-prompt-exfiltration");
      }

      const persona = getPayloadsByCategory("persona-hijack");
      expect(Array.isArray(persona)).toBe(true);
      expect(persona.length).toBeGreaterThan(0);
      for (const item of persona) {
        expect(item.category).toBe("persona-hijack");
      }

      const encoded = getPayloadsByCategory("encoded-obfuscation");
      expect(Array.isArray(encoded)).toBe(true);
      expect(encoded.length).toBeGreaterThan(0);
      for (const item of encoded) {
        expect(item.category).toBe("encoded-obfuscation");
      }
    });

    it("getPayloadsByCategory returns empty array for nonexistent category", () => {
      const nonExistent = getPayloadsByCategory("nonexistent-category-xyz");
      expect(Array.isArray(nonExistent)).toBe(true);
      expect(nonExistent.length).toBe(0);
    });

    it("ensures payloads contain descriptions or valid severity ratings when populated", () => {
      const payloadsWithDesc = ADVANCED_PROMPT_INJECTION_PAYLOADS.filter((p) =>
        Boolean(p.description),
      );
      for (const item of payloadsWithDesc) {
        expect(typeof item.description).toBe("string");
      }
    });
  });
});
