import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  derive32ByteKey,
  registerEncryptionKey,
  clearKeyring,
  getActiveKeyId,
  isFindingEncryptionEnabled,
  validateFindingEncryptionConfig,
  isEncrypted,
  encryptText,
  decryptText,
  encryptFinding,
  decryptFinding,
  decryptFindings,
  reencryptFindingData,
  rotateFindingsBatch,
  DecryptionError,
  DEFAULT_KEY_ID,
} from "./finding-encryption";

describe("finding-encryption (#2016)", () => {
  const testKeyHex1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const testKeyHex2 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

  beforeEach(() => {
    clearKeyring();
    delete process.env.ENCRYPTION_ENABLED;
    delete process.env.FINDINGS_ENCRYPTION_ENABLED;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_ID;
    delete process.env.ENCRYPTION_KEYS;
  });

  afterEach(() => {
    clearKeyring();
  });

  describe("derive32ByteKey", () => {
    it("derives a 32-byte buffer from a 64-character hex string", () => {
      const key = derive32ByteKey(testKeyHex1);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
      expect(key.toString("hex")).toBe(testKeyHex1);
    });

    it("derives a 32-byte buffer from a 44-character base64 string", () => {
      const original = crypto.randomBytes(32);
      const b64 = original.toString("base64");
      const key = derive32ByteKey(b64);
      expect(key.length).toBe(32);
      expect(key.equals(original)).toBe(true);
    });

    it("derives a 32-byte key from an exact 32-character string", () => {
      const str32 = "12345678901234567890123456789012";
      const key = derive32ByteKey(str32);
      expect(key.length).toBe(32);
      expect(key.toString("utf8")).toBe(str32);
    });

    it("hashes arbitrary passphrase into 32 bytes using SHA-256", () => {
      const key = derive32ByteKey("my-secret-passphrase");
      expect(key.length).toBe(32);
      const expected = crypto.createHash("sha256").update("my-secret-passphrase", "utf8").digest();
      expect(key.equals(expected)).toBe(true);
    });

    it("throws when key is empty", () => {
      expect(() => derive32ByteKey("")).toThrow(/cannot be empty/i);
    });
  });

  describe("encryptText & decryptText", () => {
    beforeEach(() => {
      registerEncryptionKey("v1", testKeyHex1);
    });

    it("encrypts and decrypts text cleanly using AES-256-GCM", () => {
      const plaintext = "const secretApiKey = 'sk-live-123456';";
      const encrypted = encryptText(plaintext, { keyId: "v1" })!;

      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.startsWith("enc:v1:aes-256-gcm:")).toBe(true);
      expect(isEncrypted(encrypted)).toBe(true);

      const decrypted = decryptText(encrypted, { keyId: "v1" });
      expect(decrypted).toBe(plaintext);
    });

    it("returns plaintext unchanged when input is not encrypted (transparent legacy rows)", () => {
      const raw = "const plainCode = 123;";
      expect(isEncrypted(raw)).toBe(false);
      expect(decryptText(raw)).toBe(raw);
    });

    it("handles null and empty values cleanly", () => {
      expect(encryptText(null)).toBeNull();
      expect(encryptText(undefined)).toBeNull();
      expect(encryptText("")).toBe("");

      expect(decryptText(null)).toBeNull();
      expect(decryptText(undefined)).toBeNull();
      expect(decryptText("")).toBe("");
    });

    it("prevents double-encryption if input is already encrypted", () => {
      const plaintext = "sensitive code";
      const encryptedOnce = encryptText(plaintext, { keyId: "v1" })!;
      const encryptedTwice = encryptText(encryptedOnce, { keyId: "v1" })!;

      expect(encryptedTwice).toBe(encryptedOnce);
    });

    it("fails decryption when authenticated with a wrong key", () => {
      registerEncryptionKey("wrong-key", testKeyHex2);
      const plaintext = "sensitive content";
      const encrypted = encryptText(plaintext, { keyId: "v1" })!;

      expect(() => decryptText(encrypted, { key: testKeyHex2 })).toThrow(DecryptionError);
    });

    it("fails decryption when keyId is unknown in keyring", () => {
      const plaintext = "secret code";
      const encrypted = encryptText(plaintext, { keyId: "v1" })!;
      clearKeyring(); // Remove all keys from keyring so keyId is unknown

      expect(() => decryptText(encrypted)).toThrow(DecryptionError);
      expect(() => decryptText(encrypted)).toThrow(/unknown encryption key ID/i);
    });

    it("fails decryption on tampered ciphertext or auth tag", () => {
      const encrypted = encryptText("my secret", { keyId: "v1" })!;
      const parts = encrypted.split(":");
      // Tamper with ciphertext
      parts[5] = Buffer.from("corrupted").toString("base64");
      const tampered = parts.join(":");

      expect(() => decryptText(tampered)).toThrow(DecryptionError);
    });
  });

  describe("encryptFinding & decryptFinding transparent handling", () => {
    beforeEach(() => {
      registerEncryptionKey("v1", testKeyHex1);
    });

    it("encrypts codeSnippet and explanation when encryption is enabled", () => {
      process.env.ENCRYPTION_ENABLED = "true";
      process.env.ENCRYPTION_KEY = testKeyHex1;
      process.env.ENCRYPTION_KEY_ID = "v1";

      const finding = {
        id: "finding-1",
        fileLocation: "src/api/auth.ts",
        severity: "CRITICAL",
        codeSnippet: "const token = 'ghp_secret123';",
        explanation: "Hardcoded credential found in repository source.",
      };

      const encrypted = encryptFinding(finding);

      expect(encrypted.id).toBe("finding-1");
      expect(encrypted.fileLocation).toBe("src/api/auth.ts");
      expect(encrypted.severity).toBe("CRITICAL");
      expect(encrypted.encryptionKeyId).toBe("v1");

      expect(encrypted.codeSnippet).not.toContain("ghp_secret123");
      expect(isEncrypted(encrypted.codeSnippet)).toBe(true);

      expect(encrypted.explanation).not.toContain("Hardcoded credential");
      expect(isEncrypted(encrypted.explanation)).toBe(true);

      const decrypted = decryptFinding(encrypted);
      expect(decrypted.codeSnippet).toBe("const token = 'ghp_secret123';");
      expect(decrypted.explanation).toBe("Hardcoded credential found in repository source.");
    });

    it("does not alter finding when encryption is disabled", () => {
      process.env.ENCRYPTION_ENABLED = "false";

      const finding = {
        codeSnippet: "plain code",
        explanation: "plain explanation",
      };

      const result = encryptFinding(finding);
      expect(result.codeSnippet).toBe("plain code");
      expect(result.explanation).toBe("plain explanation");
      expect(isEncrypted(result.codeSnippet)).toBe(false);
    });

    it("batch decrypts arrays of findings with mixed encrypted and unencrypted rows", () => {
      const encryptedRow = encryptFinding(
        {
          id: "f1",
          codeSnippet: "secret 1",
          explanation: "explanation 1",
        },
        { force: true, keyId: "v1" },
      );

      const legacyPlainRow = {
        id: "f2",
        codeSnippet: "plain code",
        explanation: "plain explanation",
      };

      const list = decryptFindings([encryptedRow, legacyPlainRow]);

      expect(list[0].codeSnippet).toBe("secret 1");
      expect(list[0].explanation).toBe("explanation 1");
      expect(list[1].codeSnippet).toBe("plain code");
      expect(list[1].explanation).toBe("plain explanation");
    });
  });

  describe("startup validation", () => {
    it("fails clearly when encryption is enabled without a key", () => {
      process.env.ENCRYPTION_ENABLED = "true";
      delete process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY_FILE;

      expect(() => validateFindingEncryptionConfig(process.env)).toThrow(
        /ENCRYPTION_KEY.*is missing or empty/i,
      );
    });

    it("succeeds when encryption is enabled with a valid key", () => {
      process.env.ENCRYPTION_ENABLED = "true";
      process.env.ENCRYPTION_KEY = testKeyHex1;

      expect(() => validateFindingEncryptionConfig(process.env)).not.toThrow();
    });

    it("succeeds when encryption is disabled, even without a key", () => {
      process.env.ENCRYPTION_ENABLED = "false";
      delete process.env.ENCRYPTION_KEY;

      expect(() => validateFindingEncryptionConfig(process.env)).not.toThrow();
    });
  });

  describe("zero-downtime key rotation", () => {
    beforeEach(() => {
      registerEncryptionKey("v1", testKeyHex1);
      registerEncryptionKey("v2", testKeyHex2);
    });

    it("re-encrypts a row from v1 to v2 while remaining transparently readable", () => {
      const original = {
        id: "row-1",
        codeSnippet: "const password = 'super_secret';",
        explanation: "Leaked database password.",
        encryptionKeyId: "v1",
      };

      // Encrypt initially with v1
      const rowV1 = encryptFinding(original, { force: true, keyId: "v1" });
      expect(rowV1.encryptionKeyId).toBe("v1");
      expect(isEncrypted(rowV1.codeSnippet)).toBe(true);

      // Re-encrypt under v2
      const reencrypted = reencryptFindingData(rowV1, "v2");
      expect(reencrypted.encryptionKeyId).toBe("v2");
      expect(reencrypted.codeSnippet).toContain("enc:v2:aes-256-gcm:");
      expect(reencrypted.explanation).toContain("enc:v2:aes-256-gcm:");

      // Decrypt row under v2 key
      const decrypted = decryptFinding({
        ...original,
        codeSnippet: reencrypted.codeSnippet,
        explanation: reencrypted.explanation,
        encryptionKeyId: reencrypted.encryptionKeyId,
      });

      expect(decrypted.codeSnippet).toBe("const password = 'super_secret';");
      expect(decrypted.explanation).toBe("Leaked database password.");
    });

    it("rotates findings in batches using rotateFindingsBatch", async () => {
      const mockRows = [
        {
          id: "f1",
          codeSnippet: encryptText("code 1", { keyId: "v1" }),
          explanation: encryptText("expl 1", { keyId: "v1" }),
          encryptionKeyId: "v1",
        },
        {
          id: "f2",
          codeSnippet: "unencrypted legacy code",
          explanation: "unencrypted explanation",
          encryptionKeyId: null,
        },
      ];

      const updatedRows: Record<string, any> = {};

      const mockPrisma = {
        finding: {
          findMany: vi.fn().mockResolvedValueOnce(mockRows).mockResolvedValueOnce([]), // second call returns empty batch to terminate loop
          update: vi.fn().mockImplementation(async ({ where, data }: any) => {
            updatedRows[where.id] = data;
            return { id: where.id, ...data };
          }),
        },
      };

      const result = await rotateFindingsBatch(mockPrisma as any, {
        batchSize: 10,
        targetKeyId: "v2",
        dryRun: false,
      });

      expect(result.totalScanned).toBe(2);
      expect(result.reencryptedCount).toBe(2);
      expect(result.failedCount).toBe(0);

      // Check updated row f1
      expect(updatedRows["f1"].encryptionKeyId).toBe("v2");
      expect(isEncrypted(updatedRows["f1"].codeSnippet)).toBe(true);
      expect(decryptText(updatedRows["f1"].codeSnippet, { keyId: "v2" })).toBe("code 1");

      // Check updated row f2 (legacy plaintext converted to encrypted)
      expect(updatedRows["f2"].encryptionKeyId).toBe("v2");
      expect(isEncrypted(updatedRows["f2"].codeSnippet)).toBe(true);
      expect(decryptText(updatedRows["f2"].codeSnippet, { keyId: "v2" })).toBe(
        "unencrypted legacy code",
      );
    });

    it("respects dryRun option without modifying database", async () => {
      const mockRows = [
        {
          id: "f1",
          codeSnippet: "secret",
          explanation: "explanation",
          encryptionKeyId: "v1",
        },
      ];

      const mockPrisma = {
        finding: {
          findMany: vi.fn().mockResolvedValueOnce(mockRows).mockResolvedValueOnce([]),
          update: vi.fn(),
        },
      };

      const result = await rotateFindingsBatch(mockPrisma as any, {
        targetKeyId: "v2",
        dryRun: true,
      });

      expect(result.reencryptedCount).toBe(1);
      expect(mockPrisma.finding.update).not.toHaveBeenCalled();
    });
  });
});
