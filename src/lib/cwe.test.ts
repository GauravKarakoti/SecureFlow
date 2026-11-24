import { describe, it, expect } from "vitest";
import { CWE_CATALOG, isValidCwe, normalizeCwe, getCweUrl, resolveCwe } from "./cwe";

describe("CWE Taxonomy & Mapping Engine (#2008)", () => {
  describe("isValidCwe", () => {
    it("returns true for valid CWE identifiers", () => {
      expect(isValidCwe("CWE-798")).toBe(true);
      expect(isValidCwe("CWE-89")).toBe(true);
      expect(isValidCwe("cwe-78")).toBe(true);
      expect(isValidCwe("  CWE-1395  ")).toBe(true);
    });

    it("returns false for invalid values", () => {
      expect(isValidCwe("")).toBe(false);
      expect(isValidCwe("CVE-2023-1234")).toBe(false);
      expect(isValidCwe("OWASP-A01")).toBe(false);
      expect(isValidCwe(null)).toBe(false);
      expect(isValidCwe(undefined)).toBe(false);
      expect(isValidCwe(123)).toBe(false);
    });
  });

  describe("normalizeCwe", () => {
    it("normalizes CWE strings to canonical uppercase form", () => {
      expect(normalizeCwe("cwe-89")).toBe("CWE-89");
      expect(normalizeCwe("CWE_798")).toBe("CWE-798");
      expect(normalizeCwe("  cwe-79  ")).toBe("CWE-79");
    });
  });

  describe("getCweUrl", () => {
    it("returns MITRE definition link for valid CWEs", () => {
      expect(getCweUrl("CWE-798")).toBe("https://cwe.mitre.org/data/definitions/798.html");
      expect(getCweUrl("CWE-89")).toBe("https://cwe.mitre.org/data/definitions/89.html");
      expect(getCweUrl("cwe-22")).toBe("https://cwe.mitre.org/data/definitions/22.html");
    });

    it("returns empty string for invalid CWEs", () => {
      expect(getCweUrl("INVALID")).toBe("");
      expect(getCweUrl("")).toBe("");
    });
  });

  describe("resolveCwe built-in policy mappings", () => {
    it("maps built-in secret policies to CWE-798 / CWE-259", () => {
      expect(resolveCwe({ type: "SECRET" })).toBe("CWE-798");
      expect(resolveCwe({ type: "Hardcoded Secret" })).toBe("CWE-798");
      expect(resolveCwe({ type: "API Key" })).toBe("CWE-798");
      expect(resolveCwe({ type: "hardcoded_password" })).toBe("CWE-259");
      expect(resolveCwe({ explanation: "Found hardcoded AWS secret key in config" })).toBe(
        "CWE-798",
      );
    });

    it("maps SQL injection to CWE-89", () => {
      expect(resolveCwe({ type: "SQL_INJECTION" })).toBe("CWE-89");
      expect(resolveCwe({ explanation: "Detected potential SQL injection via raw query" })).toBe(
        "CWE-89",
      );
    });

    it("maps command injection to CWE-78", () => {
      expect(resolveCwe({ type: "COMMAND_INJECTION" })).toBe("CWE-78");
      expect(
        resolveCwe({ explanation: "Unsanitized input reaches os.system command injection" }),
      ).toBe("CWE-78");
    });

    it("maps XSS to CWE-79", () => {
      expect(resolveCwe({ type: "XSS" })).toBe("CWE-79");
      expect(resolveCwe({ explanation: "Unescaped HTML leads to cross-site scripting" })).toBe(
        "CWE-79",
      );
    });

    it("maps path traversal to CWE-22", () => {
      expect(resolveCwe({ type: "PATH_TRAVERSAL" })).toBe("CWE-22");
      expect(resolveCwe({ explanation: "File lookup vulnerable to directory traversal" })).toBe(
        "CWE-22",
      );
    });

    it("maps SSRF to CWE-918", () => {
      expect(resolveCwe({ type: "SSRF" })).toBe("CWE-918");
      expect(
        resolveCwe({
          explanation: "Outgoing HTTP request vulnerable to server-side request forgery",
        }),
      ).toBe("CWE-918");
    });

    it("maps insecure deserialization to CWE-502", () => {
      expect(resolveCwe({ type: "INSECURE_DESERIALIZATION" })).toBe("CWE-502");
      expect(resolveCwe({ codeSnippet: "pickle.loads(untrusted_payload)" })).toBe("CWE-502");
    });

    it("maps smart contract reentrancy to CWE-841", () => {
      expect(resolveCwe({ type: "REENTRANCY" })).toBe("CWE-841");
      expect(
        resolveCwe({
          explanation: "Untrusted external call before state change leads to reentrancy",
        }),
      ).toBe("CWE-841");
    });

    it("maps infrastructure misconfigurations to appropriate CWEs", () => {
      expect(resolveCwe({ policy: "PRIVILEGED_CONTAINER" })).toBe("CWE-250");
      expect(resolveCwe({ policy: "ROOT_USER" })).toBe("CWE-250");
      expect(
        resolveCwe({ explanation: "Container runs with root user or privileged container" }),
      ).toBe("CWE-250");
      expect(resolveCwe({ policy: "PUBLIC_BUCKET" })).toBe("CWE-732");
      expect(resolveCwe({ policy: "OPEN_SECURITY_GROUP" })).toBe("CWE-284");
    });

    it("maps dependency supply chain issues to CWE-1395", () => {
      expect(resolveCwe({ policy: "TYPOSQUAT" })).toBe("CWE-1395");
      expect(resolveCwe({ explanation: "Package lodash-fake is a typosquat of lodash" })).toBe(
        "CWE-1395",
      );
    });

    it("preserves explicitly provided valid CWE", () => {
      expect(resolveCwe({ cwe: "CWE-999", type: "SECRET" })).toBe("CWE-999");
    });

    it("extracts embedded CWE identifier from text", () => {
      expect(
        resolveCwe({ explanation: "Vulnerability identified (CWE-434): Unrestricted file upload" }),
      ).toBe("CWE-434");
    });

    it("returns undefined for unknown categories leaving the field empty", () => {
      expect(
        resolveCwe({ type: "CompletelyUnknownWidgetFailure", explanation: "Something broke" }),
      ).toBeUndefined();
      expect(resolveCwe({})).toBeUndefined();
    });
  });

  describe("CWE catalog integrity", () => {
    it("ensures all catalog entries have valid CWE IDs and URLs", () => {
      for (const [id, def] of Object.entries(CWE_CATALOG)) {
        expect(isValidCwe(id)).toBe(true);
        expect(def.id).toBe(id);
        expect(getCweUrl(id)).toContain("https://cwe.mitre.org/data/definitions/");
      }
    });
  });
});
