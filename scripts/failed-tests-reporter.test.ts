import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isTestModuleFailed,
  getModulePath,
  getFailedFilePaths,
  formatFailedFilesSummary,
  FailedTestsReporter,
} from "./failed-tests-reporter.js";

describe("scripts/failed-tests-reporter (#1719)", () => {
  describe("isTestModuleFailed", () => {
    it("returns false for null/undefined", () => {
      expect(isTestModuleFailed(null)).toBe(false);
      expect(isTestModuleFailed(undefined)).toBe(false);
    });

    it("returns true when ok() returns false", () => {
      expect(isTestModuleFailed({ ok: () => false })).toBe(true);
      expect(isTestModuleFailed({ ok: false })).toBe(true);
    });

    it("returns false when ok() returns true", () => {
      expect(isTestModuleFailed({ ok: () => true })).toBe(false);
      expect(isTestModuleFailed({ ok: true })).toBe(false);
    });

    it("returns true when state is 'failed'", () => {
      expect(isTestModuleFailed({ state: () => "failed" })).toBe(true);
      expect(isTestModuleFailed({ state: "failed" })).toBe(true);
      expect(isTestModuleFailed({ state: "fail" })).toBe(true);
    });

    it("returns true when errors list has items", () => {
      expect(isTestModuleFailed({ errors: () => [new Error("boom")] })).toBe(true);
      expect(isTestModuleFailed({ errors: ["syntax error"] })).toBe(true);
    });

    it("returns true when result.state is failed", () => {
      expect(isTestModuleFailed({ result: { state: "failed" } })).toBe(true);
      expect(isTestModuleFailed({ result: { state: "fail" } })).toBe(true);
    });

    it("returns false for clean passing module", () => {
      expect(isTestModuleFailed({ ok: () => true, state: () => "passed", errors: () => [] })).toBe(
        false,
      );
    });
  });

  describe("getModulePath", () => {
    it("returns relativeModuleId if present", () => {
      expect(getModulePath({ relativeModuleId: "src\\auth.test.ts" })).toBe("src/auth.test.ts");
    });

    it("strips cwd prefix from absolute moduleId", () => {
      const cwd = "/workspace/project";
      const moduleId = "/workspace/project/src/lib/tui.test.ts";
      expect(getModulePath({ moduleId }, cwd)).toBe("src/lib/tui.test.ts");
    });

    it("handles Windows paths and backslashes", () => {
      const cwd = "C:\\Users\\User\\project";
      const moduleId = "C:\\Users\\User\\project\\src\\api.test.ts";
      expect(getModulePath({ moduleId }, cwd)).toBe("src/api.test.ts");
    });

    it("falls back to filepath or name", () => {
      expect(getModulePath({ filepath: "tests/e2e.test.ts" })).toBe("tests/e2e.test.ts");
      expect(getModulePath({ name: "cli/index.test.ts" })).toBe("cli/index.test.ts");
    });
  });

  describe("getFailedFilePaths", () => {
    it("returns empty array when all pass", () => {
      const modules = [
        { relativeModuleId: "a.test.ts", ok: () => true, state: () => "passed" },
        { relativeModuleId: "b.test.ts", ok: () => true, state: () => "passed" },
      ];
      expect(getFailedFilePaths(modules)).toEqual([]);
    });

    it("extracts and deduplicates failing module paths", () => {
      const modules = [
        { relativeModuleId: "a.test.ts", ok: () => true },
        { relativeModuleId: "b.test.ts", ok: () => false },
        { relativeModuleId: "c.test.ts", state: "failed" },
        { relativeModuleId: "b.test.ts", ok: () => false },
      ];
      expect(getFailedFilePaths(modules)).toEqual(["b.test.ts", "c.test.ts"]);
    });
  });

  describe("formatFailedFilesSummary", () => {
    it("returns empty string when no failed files", () => {
      expect(formatFailedFilesSummary([])).toBe("");
    });

    it("formats failed files list with header and count", () => {
      const output = formatFailedFilesSummary(["src/a.test.ts", "src/b.test.ts"]);
      expect(output).toContain("Failed Test Files (2)");
      expect(output).toContain("src/a.test.ts");
      expect(output).toContain("src/b.test.ts");
      expect(output).toContain("✖");
    });
  });

  describe("FailedTestsReporter class", () => {
    let reporter: FailedTestsReporter;
    let logSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      reporter = new FailedTestsReporter();
      logSpy = vi.fn();
      reporter.onInit({ logger: { log: logSpy } });
    });

    it("prints failed files at the end of the test run when failures exist", () => {
      reporter.onTestRunStart();
      reporter.onTestRunEnd([
        { relativeModuleId: "src/auth.test.ts", ok: () => false },
        { relativeModuleId: "src/db.test.ts", ok: () => true },
      ]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0][0];
      expect(logged).toContain("Failed Test Files (1)");
      expect(logged).toContain("src/auth.test.ts");
    });

    it("does not print anything when all tests pass", () => {
      reporter.onTestRunStart();
      reporter.onTestRunEnd([{ relativeModuleId: "src/pass.test.ts", ok: () => true }]);

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("avoids duplicate reporting if both onTestRunEnd and onFinished are triggered", () => {
      reporter.onTestRunStart();
      const failingModules = [{ relativeModuleId: "src/fail.test.ts", ok: () => false }];

      reporter.onTestRunEnd(failingModules);
      reporter.onFinished(failingModules);

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("resets reported state on next test run start", () => {
      reporter.onTestRunStart();
      reporter.onTestRunEnd([{ relativeModuleId: "src/fail.test.ts", ok: () => false }]);
      expect(logSpy).toHaveBeenCalledTimes(1);

      reporter.onTestRunStart();
      reporter.onTestRunEnd([{ relativeModuleId: "src/fail2.test.ts", ok: () => false }]);
      expect(logSpy).toHaveBeenCalledTimes(2);
    });
  });
});
