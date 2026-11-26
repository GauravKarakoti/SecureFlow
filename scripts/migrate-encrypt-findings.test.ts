import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCliArgs, runMigration } from "./migrate-encrypt-findings";
import { registerEncryptionKey, clearKeyring } from "@/lib/security/finding-encryption";

describe("migrate-encrypt-findings CLI script (#2016)", () => {
  const testKeyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    clearKeyring();
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_ID;
    delete process.env.ENCRYPTION_ENABLED;
  });

  describe("parseCliArgs", () => {
    it("parses default arguments", () => {
      const args = parseCliArgs([]);
      expect(args.batchSize).toBe(100);
      expect(args.targetKeyId).toBeUndefined();
      expect(args.dryRun).toBe(false);
      expect(args.help).toBe(false);
    });

    it("parses custom batch size, target key ID, and dry-run flag", () => {
      const args = parseCliArgs(["--batch-size", "250", "--target-key-id", "v2", "--dry-run"]);
      expect(args.batchSize).toBe(250);
      expect(args.targetKeyId).toBe("v2");
      expect(args.dryRun).toBe(true);
      expect(args.help).toBe(false);
    });

    it("parses help flag", () => {
      expect(parseCliArgs(["--help"]).help).toBe(true);
      expect(parseCliArgs(["-h"]).help).toBe(true);
    });
  });

  describe("runMigration", () => {
    it("fails when ENCRYPTION_KEY is not configured", async () => {
      process.env.ENCRYPTION_ENABLED = "true";
      delete process.env.ENCRYPTION_KEY;

      const mockPrisma = { finding: { findMany: vi.fn(), update: vi.fn() } };

      await expect(
        runMigration({ batchSize: 50, dryRun: false, help: false }, mockPrisma as any),
      ).rejects.toThrow(/ENCRYPTION_KEY/i);
    });

    it("executes migration cleanly when key is provided", async () => {
      process.env.ENCRYPTION_KEY = testKeyHex;
      process.env.ENCRYPTION_KEY_ID = "v1";
      registerEncryptionKey("v1", testKeyHex);

      const mockRows = [
        {
          id: "f-101",
          codeSnippet: "const token = 1;",
          explanation: "Insecure token",
          encryptionKeyId: null,
        },
      ];

      const mockPrisma = {
        finding: {
          findMany: vi.fn().mockResolvedValueOnce(mockRows).mockResolvedValueOnce([]),
          update: vi.fn().mockResolvedValue({ id: "f-101" }),
        },
      };

      const result = await runMigration(
        { batchSize: 50, dryRun: false, help: false },
        mockPrisma as any,
      );

      expect(result.totalScanned).toBe(1);
      expect(result.reencryptedCount).toBe(1);
      expect(mockPrisma.finding.update).toHaveBeenCalledTimes(1);
    });
  });
});
