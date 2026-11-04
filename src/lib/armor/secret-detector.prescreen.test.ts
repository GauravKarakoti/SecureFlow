import { describe, expect, it } from "vitest";
import { detectSecretsInPatch, mergeFindings } from "./secret-detector";

// Synthetic fake secrets, built at runtime so scanners don't flag this file.
const AWS = "AKIA" + "Q7XM2PLKD93HTRWN";
const GITHUB = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";
const HIGH_ENTROPY = "q8Zr3KfV9xLm2PwT7bNcXy4D";

function patchOf(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => "+" + l)].join("\n");
}

describe("deterministic pre-screen (#1517)", () => {
  it("happy path: AWS key, GitHub token and PEM header give three masked CRITICAL findings", () => {
    const findings = detectSecretsInPatch(
      "src/config.ts",
      patchOf([`const a = "${AWS}";`, `const b = "${GITHUB}";`, PEM]),
    );

    expect(findings).toHaveLength(3);
    for (const f of findings) {
      expect(f.severity).toBe("CRITICAL");
      expect(f.codeSnippet).not.toContain(AWS);
      expect(f.codeSnippet).not.toContain(GITHUB);
      expect(f.codeSnippet).not.toContain(PEM);
    }
  });

  it("edge case: the same secret on two lines gives two findings", () => {
    const findings = detectSecretsInPatch(
      "a.ts",
      patchOf([`const a = "${AWS}";`, `const b = "${AWS}";`]),
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.lineStart)).toEqual([1, 2]);
  });

  it("edge case: documented EXAMPLE and changeme values are not flagged", () => {
    const findings = detectSecretsInPatch(
      "a.ts",
      patchOf(['const a = "AKIAIOSFODNN7EXAMPLE";', 'const password = "changeme-changeme-123";']),
    );

    expect(findings).toHaveLength(0);
  });

  it("does not flag a low-entropy value assigned to a secret-named variable", () => {
    const findings = detectSecretsInPatch(
      "a.ts",
      patchOf(['const password = "aaaaaaaaaaaaaaaaaaaa";']),
    );

    expect(findings).toHaveLength(0);
  });

  it("flags a high-entropy value assigned to a secret-named variable", () => {
    const findings = detectSecretsInPatch("a.ts", patchOf([`const password = "${HIGH_ENTROPY}";`]));

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("CRITICAL");
    expect(findings[0].codeSnippet).not.toContain(HIGH_ENTROPY);
  });

  it("de-duplicates when the LLM reports the same file and line", () => {
    const deterministic = detectSecretsInPatch("a.ts", patchOf([`const a = "${AWS}";`]));
    const llm = [{ ...deterministic[0], description: "LLM finding for the same line" }];

    const merged = mergeFindings(deterministic, llm);

    expect(merged).toHaveLength(1);
    expect(merged[0].description).toContain("Deterministic");
  });
});
