import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  startWatchMode,
  FakeFileWatcher,
  diffFindings,
  isIgnoredWatchPath,
  createFindingFingerprint,
  type TrackedFinding,
  type FindingDiff,
} from "./watch.js";
import { parseWatchArg } from "./lib/output-args.js";

describe("SecureFlow CLI Watch Mode (--watch)", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-watch-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  describe("CLI Argument Parsing", () => {
    it("recognizes --watch, -w, and watch subcommand", () => {
      expect(parseWatchArg(["node", "cli.js", "--watch"])).toBe(true);
      expect(parseWatchArg(["node", "cli.js", "-w"])).toBe(true);
      expect(parseWatchArg(["node", "cli.js", "watch"])).toBe(true);
      expect(parseWatchArg(["node", "cli.js", "scan", "--watch"])).toBe(true);
      expect(parseWatchArg(["node", "cli.js", "scan", "-w"])).toBe(true);
      expect(parseWatchArg(["node", "cli.js", "--watch=true"])).toBe(true);
      expect(parseWatchArg(["node", "cli.js", "scan"])).toBe(false);
      expect(parseWatchArg(["node", "cli.js"])).toBe(false);
    });
  });

  describe("Ignore Path Filtering", () => {
    it("ignores node_modules, build directories, and dot folders", () => {
      expect(isIgnoredWatchPath("node_modules/pkg/index.js")).toBe(true);
      expect(isIgnoredWatchPath("packages/app/node_modules/pkg/index.js")).toBe(true);
      expect(isIgnoredWatchPath("dist/bundle.js")).toBe(true);
      expect(isIgnoredWatchPath("build/main.js")).toBe(true);
      expect(isIgnoredWatchPath(".next/server/pages.js")).toBe(true);
      expect(isIgnoredWatchPath(".turbo/cache/123")).toBe(true);
      expect(isIgnoredWatchPath("coverage/lcov.info")).toBe(true);
      expect(isIgnoredWatchPath(".git/HEAD")).toBe(true);
      expect(isIgnoredWatchPath(".secureflow/cache/item.json")).toBe(true);
      expect(isIgnoredWatchPath("out/app.js")).toBe(true);
      expect(isIgnoredWatchPath(".cache/data")).toBe(true);
    });

    it("ignores editor backups, temporary files, and OS artifacts", () => {
      expect(isIgnoredWatchPath("src/index.ts~")).toBe(true);
      expect(isIgnoredWatchPath("src/index.ts.tmp")).toBe(true);
      expect(isIgnoredWatchPath("src/index.ts.swp")).toBe(true);
      expect(isIgnoredWatchPath("src/.#index.ts")).toBe(true);
      expect(isIgnoredWatchPath("src/.DS_Store")).toBe(true);
      expect(isIgnoredWatchPath("src/thumbs.db")).toBe(true);
    });

    it("allows standard source code files", () => {
      expect(isIgnoredWatchPath("src/auth.ts")).toBe(false);
      expect(isIgnoredWatchPath("lib/scanner.js")).toBe(false);
      expect(isIgnoredWatchPath("routes/api.py")).toBe(false);
      expect(isIgnoredWatchPath(".env")).toBe(false);
    });

    it("respects custom ignore RegExp patterns", () => {
      const customIgnores = [/^legacy\//, /\.test\.ts$/];
      expect(isIgnoredWatchPath("legacy/old-auth.ts", customIgnores)).toBe(true);
      expect(isIgnoredWatchPath("src/auth.test.ts", customIgnores)).toBe(true);
      expect(isIgnoredWatchPath("src/auth.ts", customIgnores)).toBe(false);
    });
  });

  describe("Finding Diff Algorithm (Resolved vs New vs Existing)", () => {
    it("identifies findings that disappeared as resolved", () => {
      const prev: TrackedFinding[] = [
        {
          filePath: "src/auth.ts",
          rule: "console-secret-logging",
          severity: "HIGH",
          line: 10,
          snippet: "console.log(process.env.API_KEY);",
          reason: "secret logging",
          fingerprint: "src/auth.ts::console-secret-logging::console.log(process.env.API_KEY);",
        },
      ];

      const current: TrackedFinding[] = [];

      const diff = diffFindings("src/auth.ts", prev, current);
      expect(diff.resolved).toHaveLength(1);
      expect(diff.resolved[0]!.snippet).toBe("console.log(process.env.API_KEY);");
      expect(diff.newFindings).toHaveLength(0);
      expect(diff.existing).toHaveLength(0);
    });

    it("identifies newly introduced findings", () => {
      const prev: TrackedFinding[] = [];
      const current: TrackedFinding[] = [
        {
          filePath: "src/auth.ts",
          rule: "console-secret-logging",
          severity: "HIGH",
          line: 15,
          snippet: "console.log(process.env.NEW_SECRET);",
          reason: "secret logging",
          fingerprint: "src/auth.ts::console-secret-logging::console.log(process.env.NEW_SECRET);",
        },
      ];

      const diff = diffFindings("src/auth.ts", prev, current);
      expect(diff.newFindings).toHaveLength(1);
      expect(diff.newFindings[0]!.snippet).toBe("console.log(process.env.NEW_SECRET);");
      expect(diff.resolved).toHaveLength(0);
      expect(diff.existing).toHaveLength(0);
    });

    it("recognizes existing findings whose line shifted without reporting them as resolved or new", () => {
      const prev: TrackedFinding[] = [
        {
          filePath: "src/auth.ts",
          rule: "console-secret-logging",
          severity: "HIGH",
          line: 10,
          snippet: "console.log(process.env.API_KEY);",
          reason: "secret logging",
          fingerprint: "src/auth.ts::console-secret-logging::console.log(process.env.API_KEY);",
        },
      ];

      // Shifted to line 18 because lines were added above it
      const current: TrackedFinding[] = [
        {
          filePath: "src/auth.ts",
          rule: "console-secret-logging",
          severity: "HIGH",
          line: 18,
          snippet: "console.log(process.env.API_KEY);",
          reason: "secret logging",
          fingerprint: "src/auth.ts::console-secret-logging::console.log(process.env.API_KEY);",
        },
      ];

      const diff = diffFindings("src/auth.ts", prev, current);
      expect(diff.resolved).toHaveLength(0);
      expect(diff.newFindings).toHaveLength(0);
      expect(diff.existing).toHaveLength(1);
      expect(diff.existing[0]!.line).toBe(18);
    });
  });

  describe("Watch Session with Fake File Watcher", () => {
    it("debounces rapid saves and rescans only the changed file exactly once", async () => {
      const fakeWatcher = new FakeFileWatcher();
      const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const scanStartMock = vi.fn();
      const scanCompleteMock = vi.fn();

      // Create a test file
      const filePath = path.join(tempDir, "src", "app.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'console.log("clean code");\n');

      const session = await startWatchMode({
        workspaceRoot: tempDir,
        debounceMs: 200,
        initialScan: false,
        registerSignalHandlers: false,
        logger: mockLogger,
        watcherFactory: (_dir, _opts, cb) => {
          fakeWatcher.addCallback(cb);
          return fakeWatcher;
        },
        onScanStart: scanStartMock,
        onScanComplete: scanCompleteMock,
      });

      // Rapidly emit 3 save change events within 50ms for src/app.ts
      fakeWatcher.emit("change", "src/app.ts");
      vi.advanceTimersByTime(50);
      fakeWatcher.emit("change", "src/app.ts");
      vi.advanceTimersByTime(50);
      fakeWatcher.emit("change", "src/app.ts");

      // Verify no rescan has executed yet during the debounce window
      expect(scanStartMock).not.toHaveBeenCalled();

      // Advance past the 200ms debounce interval
      await vi.advanceTimersByTimeAsync(250);

      // Verify the file was scanned EXACTLY once
      expect(scanStartMock).toHaveBeenCalledTimes(1);
      expect(scanStartMock).toHaveBeenCalledWith("src/app.ts");
      expect(scanCompleteMock).toHaveBeenCalledTimes(1);

      await session.stop();
    });

    it("reports a fixed finding as resolved when developer edits the file", async () => {
      const fakeWatcher = new FakeFileWatcher();
      const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const resolvedMock = vi.fn();
      const scanCompleteMock = vi.fn();

      // Create a file with a secret violation
      const filePath = path.join(tempDir, "src", "auth.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "console.log(process.env.SECRET_TOKEN);\n");

      // Start watch mode with initial scan so it detects the finding
      const session = await startWatchMode({
        workspaceRoot: tempDir,
        debounceMs: 150,
        initialScan: true,
        registerSignalHandlers: false,
        logger: mockLogger,
        watcherFactory: (_dir, _opts, cb) => {
          fakeWatcher.addCallback(cb);
          return fakeWatcher;
        },
        onResolvedFinding: resolvedMock,
        onScanComplete: scanCompleteMock,
      });

      // Confirm finding was registered in initial scan
      expect(session.getTotalActiveFindings()).toBe(1);
      expect(session.getTrackedFindings("src/auth.ts")).toHaveLength(1);

      // Now developer fixes the file by replacing the secret logging
      fs.writeFileSync(filePath, 'console.log("authorized user");\n');

      // Watcher emits file change event
      fakeWatcher.emit("change", "src/auth.ts");

      // Advance past debounce window
      await vi.advanceTimersByTimeAsync(200);

      // Verify resolved finding was reported
      expect(resolvedMock).toHaveBeenCalledTimes(1);
      const [resolvedPath, resolvedFinding] = resolvedMock.mock.calls[0]!;
      expect(resolvedPath).toBe("src/auth.ts");
      expect(resolvedFinding.snippet).toContain("process.env.SECRET_TOKEN");

      // Verify log message includes resolved notification
      const logMessages = mockLogger.log.mock.calls.map((c) => c[0]).join("\n");
      expect(logMessages).toContain("Resolved:");
      expect(logMessages).toContain("All findings resolved in");

      // Verify total active findings is now 0
      expect(session.getTotalActiveFindings()).toBe(0);

      await session.stop();
    });

    it("reports newly introduced findings when a violation is added", async () => {
      const fakeWatcher = new FakeFileWatcher();
      const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const newFindingMock = vi.fn();

      // Start clean
      const filePath = path.join(tempDir, "src", "client.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'console.log("clean");\n');

      const session = await startWatchMode({
        workspaceRoot: tempDir,
        debounceMs: 150,
        initialScan: true,
        registerSignalHandlers: false,
        logger: mockLogger,
        watcherFactory: (_dir, _opts, cb) => {
          fakeWatcher.addCallback(cb);
          return fakeWatcher;
        },
        onNewFinding: newFindingMock,
      });

      expect(session.getTotalActiveFindings()).toBe(0);

      // Developer introduces a secret violation
      fs.writeFileSync(filePath, "console.log(process.env.STRIPE_SECRET_KEY);\n");

      fakeWatcher.emit("change", "src/client.ts");
      await vi.advanceTimersByTimeAsync(200);

      expect(newFindingMock).toHaveBeenCalledTimes(1);
      const [newPath, finding] = newFindingMock.mock.calls[0]!;
      expect(newPath).toBe("src/client.ts");
      expect(finding.snippet).toContain("STRIPE_SECRET_KEY");

      const logMessages = mockLogger.log.mock.calls.map((c) => c[0]).join("\n");
      expect(logMessages).toContain("New finding:");

      expect(session.getTotalActiveFindings()).toBe(1);

      await session.stop();
    });

    it("ignores changes in node_modules and build output directories", async () => {
      const fakeWatcher = new FakeFileWatcher();
      const scanStartMock = vi.fn();

      const session = await startWatchMode({
        workspaceRoot: tempDir,
        debounceMs: 150,
        initialScan: false,
        registerSignalHandlers: false,
        watcherFactory: (_dir, _opts, cb) => {
          fakeWatcher.addCallback(cb);
          return fakeWatcher;
        },
        onScanStart: scanStartMock,
      });

      fakeWatcher.emit("change", "node_modules/express/index.js");
      fakeWatcher.emit("change", "dist/app.bundle.js");
      fakeWatcher.emit("change", ".next/cache/webpack.json");
      fakeWatcher.emit("change", "build/index.js");
      fakeWatcher.emit("change", ".git/index");

      await vi.advanceTimersByTimeAsync(300);

      // None of the ignored paths triggered a rescan
      expect(scanStartMock).not.toHaveBeenCalled();

      await session.stop();
    });

    it("handles file deletion by clearing findings and marking them resolved", async () => {
      const fakeWatcher = new FakeFileWatcher();
      const resolvedMock = vi.fn();

      const filePath = path.join(tempDir, "src", "temp-auth.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "console.log(process.env.TEMP_TOKEN);\n");

      const session = await startWatchMode({
        workspaceRoot: tempDir,
        debounceMs: 100,
        initialScan: true,
        registerSignalHandlers: false,
        watcherFactory: (_dir, _opts, cb) => {
          fakeWatcher.addCallback(cb);
          return fakeWatcher;
        },
        onResolvedFinding: resolvedMock,
      });

      expect(session.getTotalActiveFindings()).toBe(1);

      // Delete the file
      fs.unlinkSync(filePath);

      fakeWatcher.emit("rename", "src/temp-auth.ts");
      await vi.advanceTimersByTimeAsync(150);

      expect(resolvedMock).toHaveBeenCalledTimes(1);
      expect(session.getTotalActiveFindings()).toBe(0);

      await session.stop();
    });

    it("exits cleanly when stopped and cancels any pending timers", async () => {
      const fakeWatcher = new FakeFileWatcher();
      const scanStartMock = vi.fn();

      const filePath = path.join(tempDir, "src", "service.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'console.log("test");\n');

      const session = await startWatchMode({
        workspaceRoot: tempDir,
        debounceMs: 200,
        initialScan: false,
        registerSignalHandlers: false,
        watcherFactory: (_dir, _opts, cb) => {
          fakeWatcher.addCallback(cb);
          return fakeWatcher;
        },
        onScanStart: scanStartMock,
      });

      fakeWatcher.emit("change", "src/service.ts");

      // Stop before debounce timer elapses
      await session.stop();

      // Advance timers
      await vi.advanceTimersByTimeAsync(300);

      // Verify timer was cancelled and no scan fired
      expect(scanStartMock).not.toHaveBeenCalled();
      expect(session.isWatching()).toBe(false);
      expect(fakeWatcher.closed).toBe(true);
    });
  });
});
