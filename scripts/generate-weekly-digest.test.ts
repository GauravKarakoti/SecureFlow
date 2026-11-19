import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs, printHelp, runWeeklyDigestCli } from "./generate-weekly-digest";

const {
  generateWeeklyDigestForUserMock,
  generateAllWeeklyDigestsMock,
  calculateDigestMetricsForUserMock,
  prismaUserFindManyMock,
} = vi.hoisted(() => ({
  generateWeeklyDigestForUserMock: vi.fn(),
  generateAllWeeklyDigestsMock: vi.fn(),
  calculateDigestMetricsForUserMock: vi.fn(),
  prismaUserFindManyMock: vi.fn(),
}));

vi.mock("../src/lib/digest/digest-service", () => ({
  generateWeeklyDigestForUser: generateWeeklyDigestForUserMock,
  generateAllWeeklyDigests: generateAllWeeklyDigestsMock,
  calculateDigestMetricsForUser: calculateDigestMetricsForUserMock,
  SEVEN_DAYS_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock("../src/lib/prisma", () => ({
  default: {
    user: {
      findMany: prismaUserFindManyMock,
    },
  },
}));

describe("scripts/generate-weekly-digest.ts (#1788)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseArgs", () => {
    it("parses default flags when no arguments provided", () => {
      const opts = parseArgs([]);
      expect(opts).toEqual({
        force: false,
        dryRun: false,
        noEmail: false,
        help: false,
        quiet: false,
      });
    });

    it("parses all supported CLI flags", () => {
      const opts = parseArgs([
        "--user=usr_test123",
        "--force",
        "--dry-run",
        "--no-email",
        "--quiet",
      ]);

      expect(opts.userId).toBe("usr_test123");
      expect(opts.force).toBe(true);
      expect(opts.dryRun).toBe(true);
      expect(opts.noEmail).toBe(true);
      expect(opts.quiet).toBe(true);
    });

    it("parses -h and --help", () => {
      expect(parseArgs(["-h"]).help).toBe(true);
      expect(parseArgs(["--help"]).help).toBe(true);
    });
  });

  describe("printHelp", () => {
    it("logs help message to stdout without throwing", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      printHelp();
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe("runWeeklyDigestCli", () => {
    it("returns early when --help is supplied", async () => {
      const res = await runWeeklyDigestCli(["--help"]);
      expect(res.success).toBe(true);
      expect(generateWeeklyDigestForUserMock).not.toHaveBeenCalled();
      expect(generateAllWeeklyDigestsMock).not.toHaveBeenCalled();
    });

    it("executes dry-run preview for users without persisting or sending email", async () => {
      prismaUserFindManyMock.mockResolvedValueOnce([
        {
          id: "u1",
          name: "Alice",
          codename: "CIPHER",
          email: "alice@test.local",
        },
      ]);
      calculateDigestMetricsForUserMock.mockResolvedValueOnce({
        newFindingsCount: 3,
        dismissedFindingsCount: 1,
        resolvedFindingsCount: 2,
        blockedPrsCount: 0,
        topRepositories: [],
        topFindingTypes: [],
      });

      const res = await runWeeklyDigestCli(["--dry-run", "--quiet"]);
      expect(res.success).toBe(true);
      expect(res.generated).toBe(1);
      expect(calculateDigestMetricsForUserMock).toHaveBeenCalled();
      expect(generateWeeklyDigestForUserMock).not.toHaveBeenCalled();
    });

    it("executes single user generation when --user is specified", async () => {
      generateWeeklyDigestForUserMock.mockResolvedValueOnce({
        success: true,
        emailSent: true,
      });

      const res = await runWeeklyDigestCli(["--user=u-abc", "--force", "--quiet"]);
      expect(res.success).toBe(true);
      expect(res.generated).toBe(1);
      expect(generateWeeklyDigestForUserMock).toHaveBeenCalledWith(
        "u-abc",
        expect.objectContaining({ force: true }),
      );
    });

    it("handles skipped generation when digest was recently created", async () => {
      generateWeeklyDigestForUserMock.mockResolvedValueOnce({
        skipped: true,
        reason: "already_generated",
      });

      const res = await runWeeklyDigestCli(["--user=u-abc", "--quiet"]);
      expect(res.success).toBe(true);
      expect(res.skipped).toBe(1);
      expect(res.generated).toBe(0);
    });

    it("executes batch run for all users when no user is specified", async () => {
      generateAllWeeklyDigestsMock.mockResolvedValueOnce({
        totalUsers: 10,
        generated: 8,
        skipped: 2,
        errors: [],
      });

      const res = await runWeeklyDigestCli(["--quiet"]);
      expect(res.success).toBe(true);
      expect(res.generated).toBe(8);
      expect(res.skipped).toBe(2);
      expect(generateAllWeeklyDigestsMock).toHaveBeenCalled();
    });
  });
});
