import { describe, it, expect } from "vitest";
import {
  parseIsoDateUtc,
  parseInlineDirective,
  parseAllDirectives,
  isViolationSuppressed,
  applyInlineSuppressions,
} from "./suppression.js";
import { scanFile } from "./scanner.js";
import { generateSarifReport, validateSarifDocument } from "./sarif.js";

describe("cli inline suppression directive engine (#2051)", () => {
  describe("parseIsoDateUtc", () => {
    it("parses valid YYYY-MM-DD dates in UTC", () => {
      const date = parseIsoDateUtc("2026-12-31");
      expect(date).not.toBeNull();
      expect(date?.getUTCFullYear()).toBe(2026);
      expect(date?.getUTCMonth()).toBe(11); // 0-based
      expect(date?.getUTCDate()).toBe(31);
    });

    it("rejects invalid date strings, leap overflows and out-of-range months", () => {
      expect(parseIsoDateUtc("2026-02-31")).toBeNull();
      expect(parseIsoDateUtc("2026-13-01")).toBeNull();
      expect(parseIsoDateUtc("not-a-date")).toBeNull();
      expect(parseIsoDateUtc("2026-1-1")).toBeNull();
      expect(parseIsoDateUtc("2026-04-31")).toBeNull();
    });
  });

  describe("parseInlineDirective", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");

    it("parses // secureflow-ignore: <reason>", () => {
      const line = "console.log(key); // secureflow-ignore: test key for unit testing";
      const dir = parseInlineDirective(line, 42, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.line).toBe(42);
      expect(dir?.reason).toBe("test key for unit testing");
      expect(dir?.hasReason).toBe(true);
      expect(dir?.isValid).toBe(true);
      expect(dir?.rejectionReason).toBeUndefined();
    });

    it("parses # secureflow-ignore: <reason>", () => {
      const line = "  # secureflow-ignore: benign development credentials";
      const dir = parseInlineDirective(line, 10, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.reason).toBe("benign development credentials");
      expect(dir?.isValid).toBe(true);
    });

    it("parses /* secureflow-ignore: <reason> */", () => {
      const line = "/* secureflow-ignore: mock secret in fixture */";
      const dir = parseInlineDirective(line, 5, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.reason).toBe("mock secret in fixture");
      expect(dir?.isValid).toBe(true);
    });

    it("rejects directives without a reason", () => {
      const line = "console.log(key); // secureflow-ignore";
      const dir = parseInlineDirective(line, 15, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.hasReason).toBe(false);
      expect(dir?.isValid).toBe(false);
      expect(dir?.rejectionReason).toContain("Missing required suppression justification reason");
    });

    it("parses [expires=YYYY-MM-DD] attribute and validates active expiration", () => {
      const line = "// secureflow-ignore[expires=2026-12-31]: temporary migration secret";
      const dir = parseInlineDirective(line, 20, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.rawExpiry).toBe("2026-12-31");
      expect(dir?.isValid).toBe(true);
    });

    it("rejects directives where the expiration date has passed", () => {
      const line = "// secureflow-ignore[expires=2026-01-01]: expired temporary exemption";
      const dir = parseInlineDirective(line, 20, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.isValid).toBe(false);
      expect(dir?.rejectionReason).toContain("Suppression directive expired on 2026-01-01");
    });

    it("rejects directives with malformed expiration dates", () => {
      const line = "// secureflow-ignore[expires=2026-02-31]: invalid leap day";
      const dir = parseInlineDirective(line, 20, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.isValid).toBe(false);
      expect(dir?.rejectionReason).toContain("Malformed expiration date");
    });

    it("parses [rule=...] attribute", () => {
      const line = "// secureflow-ignore[rule=environment variable]: safe local dev env";
      const dir = parseInlineDirective(line, 30, fixedNow);
      expect(dir).not.toBeNull();
      expect(dir?.rule).toBe("environment variable");
      expect(dir?.isValid).toBe(true);
    });
  });

  describe("isViolationSuppressed & applyInlineSuppressions", () => {
    const fixedNow = new Date("2026-06-01T12:00:00Z");

    it("suppresses violation on the same line (trailing directive)", () => {
      const code = `
const apiKey = "mock-secret-key";
console.log(apiKey); // secureflow-ignore: intentional mock api key in unit test
const other = 123;
`;
      const result = scanFile("test.ts", code, undefined, { now: fixedNow });
      expect(result.violations).toHaveLength(0);
      expect(result.suppressedViolations).toHaveLength(1);
      expect(result.suppressedViolations?.[0]?.suppression?.reason).toBe(
        "intentional mock api key in unit test",
      );
    });

    it("suppresses violation on the preceding line", () => {
      const code = `
// secureflow-ignore: preceding line explanation
console.log(process.env.SECRET_TOKEN);
`;
      const result = scanFile("test.ts", code, undefined, { now: fixedNow });
      expect(result.violations).toHaveLength(0);
      expect(result.suppressedViolations).toHaveLength(1);
      expect(result.suppressedViolations?.[0]?.suppression?.reason).toBe(
        "preceding line explanation",
      );
    });

    it("does not suppress violation if directive is more than 1 line above", () => {
      const code = `
// secureflow-ignore: separated by empty line

console.log(process.env.SECRET_TOKEN);
`;
      const result = scanFile("test.ts", code, undefined, { now: fixedNow });
      expect(result.violations).toHaveLength(1);
      expect(result.suppressedViolations).toBeUndefined();
    });

    it("does not suppress violation when directive has no justification reason", () => {
      const code = `
// secureflow-ignore
console.log(process.env.SECRET_TOKEN);
`;
      const result = scanFile("test.ts", code, undefined, { now: fixedNow });
      expect(result.violations).toHaveLength(1);
    });

    it("does not suppress violation when directive is expired", () => {
      const code = `
// secureflow-ignore[expires=2025-01-01]: past date
console.log(process.env.SECRET_TOKEN);
`;
      const result = scanFile("test.ts", code, undefined, { now: fixedNow });
      expect(result.violations).toHaveLength(1);
    });

    it("ignores suppressions when ignoreSuppressions is true", () => {
      const code = `
// secureflow-ignore: valid reason
console.log(process.env.SECRET_TOKEN);
`;
      const result = scanFile("test.ts", code, undefined, {
        now: fixedNow,
        ignoreSuppressions: true,
      });
      expect(result.violations).toHaveLength(1);
      expect(result.suppressedViolations).toBeUndefined();
    });

    it("respects rule filter attribute on directives", () => {
      const code = `
// secureflow-ignore[rule=secret-named identifier]: only for secret identifier
console.log(process.env.SECRET_TOKEN);
`;
      // Here violation is "environment variable", but directive specifies "secret-named identifier"
      const result = scanFile("test.ts", code, undefined, { now: fixedNow });
      expect(result.violations).toHaveLength(1);
    });
  });

  describe("SARIF output with inline suppressions", () => {
    it("includes suppressions property in SARIF result and passes schema validation", () => {
      const code = `
console.log(secret_key); // secureflow-ignore: test fixture credentials
`;
      const scanResult = scanFile("src/test.ts", code);
      expect(scanResult.violations).toHaveLength(0);
      expect(scanResult.suppressedViolations).toHaveLength(1);

      const sarif = generateSarifReport([scanResult]);
      expect(sarif.runs[0]?.results).toHaveLength(1);

      const res = sarif.runs[0]?.results[0];
      expect(res?.suppressions).toBeDefined();
      expect(res?.suppressions).toHaveLength(1);
      expect(res?.suppressions?.[0]?.kind).toBe("inSource");
      expect(res?.suppressions?.[0]?.justification).toBe("test fixture credentials");
      expect(res?.suppressions?.[0]?.status).toBe("accepted");

      const validation = validateSarifDocument(sarif);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });
});
