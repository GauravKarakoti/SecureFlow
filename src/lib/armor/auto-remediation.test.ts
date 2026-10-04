import { describe, expect, it } from "vitest";
import {
  applyScopedUnifiedDiff,
  AUTO_REMEDIATION_ARMORIQ_SCOPE,
  isAllowedAutoRemediationPath,
} from "./auto-remediation";

describe("ArmorIQ auto-remediation scope", () => {
  it("allows only source files and the PR creation tool", () => {
    expect(AUTO_REMEDIATION_ARMORIQ_SCOPE.allow).toEqual([
      "fs.readwrite ./src/**",
      "github.pull_request.create",
    ]);
    expect(isAllowedAutoRemediationPath("src/auth/session.ts")).toBe(true);
    expect(isAllowedAutoRemediationPath(".github/workflows/ci.yml")).toBe(false);
    expect(isAllowedAutoRemediationPath("src/../.github/workflows/ci.yml")).toBe(false);
    expect(isAllowedAutoRemediationPath("src\\auth\\session.ts")).toBe(false);
  });

  it("applies a matching in-scope patch", () => {
    const result = applyScopedUnifiedDiff(
      "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,2 @@\n const enabled = false;\n-enabled = false;\n+enabled = true;",
      "src/auth.ts",
      "const enabled = false;\nenabled = false;\n",
    );

    expect(result).toBe("const enabled = false;\nenabled = true;\n");
  });

  it("rejects stale content and paths outside the scope", () => {
    const patch = "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new";

    expect(() => applyScopedUnifiedDiff(patch, "src/auth.ts", "different\n")).toThrow(
      "Patch removal does not match",
    );
    expect(() => applyScopedUnifiedDiff(patch, "src/../secret.txt", "old\n")).toThrow(
      "outside the allowed src/** scope",
    );
  });
});