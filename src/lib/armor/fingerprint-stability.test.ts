import { describe, it, expect } from "vitest";
import { computeFingerprint } from "@/lib/armor/fingerprint";

describe("computeFingerprint stable fingerprinting (#1528)", () => {
  const repoId = "repo-123";
  const file = "src/auth/jwt.ts";
  const type = "SECRET";
  const snippet = 'const apiKey = "sk_live_12345";';

  it("produces deterministic SHA-256 fingerprint for identical finding properties", () => {
    const fp1 = computeFingerprint(repoId, file, type, snippet);
    const fp2 = computeFingerprint(repoId, file, type, snippet);

    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64);
  });

  it("produces a different fingerprint when code snippet changes (preventing suppression bypass)", () => {
    const originalFp = computeFingerprint(repoId, file, type, snippet);
    const modifiedSnippet = 'const apiKey = "sk_live_different_token";';
    const newFp = computeFingerprint(repoId, file, type, modifiedSnippet);

    expect(newFp).not.toBe(originalFp);
  });

  it("produces different fingerprints for different repositories, files, or types", () => {
    const baseFp = computeFingerprint(repoId, file, type, snippet);
    const diffRepo = computeFingerprint("repo-456", file, type, snippet);
    const diffFile = computeFingerprint(repoId, "src/config.ts", type, snippet);
    const diffType = computeFingerprint(repoId, file, "VULNERABILITY", snippet);

    expect(diffRepo).not.toBe(baseFp);
    expect(diffFile).not.toBe(baseFp);
    expect(diffType).not.toBe(baseFp);
  });

  it("handles null and undefined snippets cleanly", () => {
    const fpNull = computeFingerprint(repoId, file, type, null);
    const fpUndefined = computeFingerprint(repoId, file, type, undefined);
    const fpEmpty = computeFingerprint(repoId, file, type, "");

    expect(fpNull).toBe(fpUndefined);
    expect(fpNull).toBe(fpEmpty);
  });
});
