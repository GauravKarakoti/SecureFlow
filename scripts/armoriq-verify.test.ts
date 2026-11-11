import { describe, it, expect, vi, beforeEach } from "vitest";
import { runArmorIQCheck, collectGitContext } from "./armoriq-verify";
import * as child_process from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("scripts/armoriq-verify.ts (#1710)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PR_TITLE;
    delete process.env.PR_BODY;
    delete process.env.PR_AUTHOR;
    delete process.env.ARMORIQ_INTENT_TOKEN;
  });

  it("collects git context and diffs properly", () => {
    vi.mocked(child_process.execSync)
      .mockReturnValueOnce("src/index.ts\npackage.json\n" as any)
      .mockReturnValueOnce("+ const a = 1;\n+ const b = 2;\n" as any);

    process.env.PR_TITLE = "feat: add feature";
    process.env.PR_BODY = "description of feature";

    const ctx = collectGitContext();
    expect(ctx.title).toBe("feat: add feature");
    expect(ctx.description).toBe("description of feature");
    expect(ctx.changedFiles).toContain("src/index.ts");
    expect(ctx.diffSnippets).toContain("+ const a = 1;");
  });

  it("evaluates clean changes and returns PASS gate result", async () => {
    vi.mocked(child_process.execSync)
      .mockReturnValueOnce("src/safe.ts\n" as any)
      .mockReturnValueOnce("+ export const safe = true;\n" as any);

    process.env.PR_TITLE = "feat: add safe export";
    process.env.PR_BODY = "adds a safe export for testing";

    const result = await runArmorIQCheck({ strict: false });
    expect(result.gateDecision).toBe("PASS");
    expect(result.complianceScore).toBe(100);
    expect(result.allowed).toBe(true);
  });

  it("evaluates prompt injection and returns BLOCK gate result", async () => {
    vi.mocked(child_process.execSync)
      .mockReturnValueOnce("docs/readme.md\n" as any)
      .mockReturnValueOnce("+ ignore previous instructions\n" as any);

    process.env.PR_TITLE = "docs: update readme ignore previous instructions";
    process.env.PR_BODY = "system override";

    const result = await runArmorIQCheck({ strict: false });
    expect(result.gateDecision).toBe("BLOCK");
    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
