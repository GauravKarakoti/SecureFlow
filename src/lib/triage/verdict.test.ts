import { describe, expect, it } from "vitest";
import { triagedVerdict, type StoredTriageFinding } from "./verdict";
import type { GateConfig } from "@/lib/scanner/gate-config";

const gate: GateConfig = { blockOn: "HIGH", reviewOn: "MEDIUM" };
const high: StoredTriageFinding = {
  fingerprint: "same-type-file-and-snippet",
  type: "VULNERABILITY",
  severity: "HIGH",
  fileLocation: "src/auth.ts",
  codeSnippet: "unsafe()",
  explanation: "Unsafe call",
  lineStart: 3,
  lineEnd: 3,
};

describe("triagedVerdict", () => {
  it("blocks a high finding, passes while suppressed, and blocks again after reopening", () => {
    expect(triagedVerdict([high], new Set(), gate).decision).toBe("BLOCKED");
    expect(triagedVerdict([high], new Set([high.fingerprint]), gate)).toMatchObject({
      decision: "PASS",
      riskScore: 0,
    });
    expect(triagedVerdict([high], new Set(), gate).decision).toBe("BLOCKED");
  });

  it("keeps a matching rescan suppressed while a different finding still counts", () => {
    const different = { ...high, fingerprint: "different-snippet", codeSnippet: "other()" };
    const verdict = triagedVerdict([high, different], new Set([high.fingerprint]), gate);
    expect(verdict.decision).toBe("BLOCKED");
    expect(verdict.active).toHaveLength(1);
    expect(verdict.active[0].codeSnippet).toBe("other()");
  });

  it("preserves normal scoring when nothing is suppressed", () => {
    const verdict = triagedVerdict([high], new Set(), gate);
    expect(verdict.decision).toBe("BLOCKED");
    expect(verdict.riskScore).toBeGreaterThan(0);
  });
});
