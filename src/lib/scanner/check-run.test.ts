import { describe, it, expect, vi } from "vitest";
import { postScanCheckRun, postScanErrorCheckRun, SCAN_CHECK_NAME } from "./check-run";

const mk = () => ({ rest: { checks: { create: vi.fn().mockResolvedValue({}) } } });
const base = { owner: "o", repo: "r", headSha: "abc", findingsCount: 1, fileCount: 2 };

describe("postScanCheckRun", () => {
  it("fails the check on BLOCKED", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "BLOCKED" });
    expect(o.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: SCAN_CHECK_NAME, conclusion: "failure" }),
    );
  });

  it("succeeds on PASS", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "PASS" });
    expect(o.rest.checks.create.mock.calls[0][0].conclusion).toBe("success");
  });

  it("is action_required on REVIEW REQUIRED", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "REVIEW REQUIRED" });
    expect(o.rest.checks.create.mock.calls[0][0].conclusion).toBe("action_required");
  });

  it("appends the coverage notice to the summary", async () => {
    const o = mk();
    await postScanCheckRun(o, { ...base, decision: "PASS", notice: "Scan truncated" });
    expect(o.rest.checks.create.mock.calls[0][0].output.summary).toContain("Scan truncated");
  });
});

describe("postScanErrorCheckRun", () => {
  it("is fail-closed", async () => {
    const o = mk();
    await postScanErrorCheckRun(o, { owner: "o", repo: "r", headSha: "abc", reason: "boom" });
    const arg = o.rest.checks.create.mock.calls[0][0];
    expect(arg.name).toBe(SCAN_CHECK_NAME);
    expect(arg.conclusion).toBe("failure");
    expect(arg.output.summary).toContain("boom");
  });
});
