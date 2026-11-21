import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SECRET_VARS,
  resolveFileSecrets,
  resolveSecretValue,
  trimTrailingNewline,
} from "./secret-config";

describe("secret-config helper (src/lib/secret-config.ts) (#1893)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-secret-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe("trimTrailingNewline", () => {
    it("trims a single trailing newline \\n", () => {
      expect(trimTrailingNewline("super-secret\n")).toBe("super-secret");
    });

    it("trims a single trailing CRLF \\r\\n", () => {
      expect(trimTrailingNewline("super-secret\r\n")).toBe("super-secret");
    });

    it("leaves string untouched if no trailing newline exists", () => {
      expect(trimTrailingNewline("super-secret")).toBe("super-secret");
    });

    it("preserves internal newlines (e.g. multi-line PEM private keys)", () => {
      const pem =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y3y\nABCDEF123456\n-----END RSA PRIVATE KEY-----\n";
      const expected =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y3y\nABCDEF123456\n-----END RSA PRIVATE KEY-----";
      expect(trimTrailingNewline(pem)).toBe(expected);
    });
  });

  describe("resolveSecretValue", () => {
    it("returns direct environment variable value when no _FILE is set (env case)", () => {
      const source = { GROQ_API_KEY: "direct-secret-key-123" };
      expect(resolveSecretValue("GROQ_API_KEY", source)).toBe("direct-secret-key-123");
    });

    it("returns undefined when neither variable nor _FILE is set", () => {
      const source = {};
      expect(resolveSecretValue("GROQ_API_KEY", source)).toBeUndefined();
    });

    it("resolves secret from file path and trims trailing newline (file case)", () => {
      const secretFile = path.join(tempDir, "groq.txt");
      fs.writeFileSync(secretFile, "file-secret-key-abc\n", "utf8");

      const source = { GROQ_API_KEY_FILE: secretFile };
      expect(resolveSecretValue("GROQ_API_KEY", source)).toBe("file-secret-key-abc");
    });

    it("preserves internal newlines when resolving from file", () => {
      const secretFile = path.join(tempDir, "key.pem");
      const pemContent =
        "-----BEGIN RSA PRIVATE KEY-----\nline1\nline2\n-----END RSA PRIVATE KEY-----\n";
      fs.writeFileSync(secretFile, pemContent, "utf8");

      const source = { GITHUB_PRIVATE_KEY_FILE: secretFile };
      const resolved = resolveSecretValue("GITHUB_PRIVATE_KEY", source);
      expect(resolved).toBe(
        "-----BEGIN RSA PRIVATE KEY-----\nline1\nline2\n-----END RSA PRIVATE KEY-----",
      );
    });

    it("fails with a clear error when both NAME and NAME_FILE are set (both-set case)", () => {
      const secretFile = path.join(tempDir, "groq.txt");
      fs.writeFileSync(secretFile, "file-val\n", "utf8");

      const directSecret = "very-confidential-direct-value";
      const source = {
        GROQ_API_KEY: directSecret,
        GROQ_API_KEY_FILE: secretFile,
      };

      expect(() => resolveSecretValue("GROQ_API_KEY", source)).toThrowError(
        /Cannot specify both GROQ_API_KEY and GROQ_API_KEY_FILE\. Choose one secret source\./,
      );

      // Verify that secret values are NEVER printed in the error message
      try {
        resolveSecretValue("GROQ_API_KEY", source);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).not.toContain(directSecret);
        expect(err.message).not.toContain("file-val");
      }
    });

    it("allows NAME_FILE when direct variable is an empty placeholder string", () => {
      const secretFile = path.join(tempDir, "db.txt");
      fs.writeFileSync(secretFile, "postgresql://localhost:5432/db\n", "utf8");

      const source = {
        DATABASE_URL: "", // Empty string in .env placeholder
        DATABASE_URL_FILE: secretFile,
      };

      expect(resolveSecretValue("DATABASE_URL", source)).toBe("postgresql://localhost:5432/db");
    });

    it("fails with a readable error when file is missing (missing-file case)", () => {
      const missingPath = path.join(tempDir, "non_existent_secret.txt");
      const source = {
        AUTH_SECRET_FILE: missingPath,
      };

      expect(() => resolveSecretValue("AUTH_SECRET", source)).toThrowError(
        /Failed to read secret for AUTH_SECRET from AUTH_SECRET_FILE/,
      );

      try {
        resolveSecretValue("AUTH_SECRET", source);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("AUTH_SECRET");
        expect(err.message).toContain("AUTH_SECRET_FILE");
        expect(err.message).toContain(missingPath);
      }
    });

    it("fails with a readable error when file reader encounters an unreadable file", () => {
      const unreadablePath = "/unreadable/path/secret";
      const source = {
        BREVO_API_KEY_FILE: unreadablePath,
      };

      const failingReader = () => {
        throw new Error("EACCES: permission denied, open '/unreadable/path/secret'");
      };

      expect(() => resolveSecretValue("BREVO_API_KEY", source, failingReader)).toThrowError(
        /Failed to read secret for BREVO_API_KEY from BREVO_API_KEY_FILE.*permission denied/,
      );
    });
  });

  describe("resolveFileSecrets", () => {
    it("resolves multiple configured secret variables in-place", () => {
      const dbFile = path.join(tempDir, "db.txt");
      const authFile = path.join(tempDir, "auth.txt");
      fs.writeFileSync(dbFile, "postgresql://user:pass@db:5432/db\n");
      fs.writeFileSync(authFile, "super-secret-auth-key\n");

      const envObj: Record<string, string | undefined> = {
        DATABASE_URL_FILE: dbFile,
        AUTH_SECRET_FILE: authFile,
        GROQ_API_KEY: "direct-groq-key",
      };

      const resolved = resolveFileSecrets(envObj, { mutateProcessEnv: false });

      expect(resolved.DATABASE_URL).toBe("postgresql://user:pass@db:5432/db");
      expect(resolved.AUTH_SECRET).toBe("super-secret-auth-key");
      expect(resolved.GROQ_API_KEY).toBe("direct-groq-key");
    });

    it("dynamically discovers and resolves any custom variable ending in _FILE", () => {
      const customSecretFile = path.join(tempDir, "custom.txt");
      fs.writeFileSync(customSecretFile, "custom-secret-token\n");

      const envObj: Record<string, string | undefined> = {
        MY_CUSTOM_INTEGRATION_TOKEN_FILE: customSecretFile,
      };

      const resolved = resolveFileSecrets(envObj, { mutateProcessEnv: false });
      expect(resolved.MY_CUSTOM_INTEGRATION_TOKEN).toBe("custom-secret-token");
    });

    it("mutates process.env when mutateProcessEnv is true", () => {
      const keyFile = path.join(tempDir, "redis.txt");
      fs.writeFileSync(keyFile, "redis://default:token@localhost:6379\n");

      const testVarName = "UPSTASH_REDIS_REST_TOKEN";
      const oldVal = process.env[testVarName];

      try {
        const envObj = {
          [`${testVarName}_FILE`]: keyFile,
        };

        resolveFileSecrets(envObj, { mutateProcessEnv: true });
        expect(process.env[testVarName]).toBe("redis://default:token@localhost:6379");
      } finally {
        if (oldVal !== undefined) {
          process.env[testVarName] = oldVal;
        } else {
          delete process.env[testVarName];
        }
      }
    });

    it("contains all expected default secret variable names in DEFAULT_SECRET_VARS", () => {
      expect(DEFAULT_SECRET_VARS).toContain("DATABASE_URL");
      expect(DEFAULT_SECRET_VARS).toContain("DATABASE_POOL_URL");
      expect(DEFAULT_SECRET_VARS).toContain("GROQ_API_KEY");
      expect(DEFAULT_SECRET_VARS).toContain("GITHUB_WEBHOOK_SECRET");
      expect(DEFAULT_SECRET_VARS).toContain("GITHUB_PRIVATE_KEY");
      expect(DEFAULT_SECRET_VARS).toContain("GITHUB_CLIENT_SECRET");
      expect(DEFAULT_SECRET_VARS).toContain("AUTH_SECRET");
      expect(DEFAULT_SECRET_VARS).toContain("ARMORIQ_API_KEY");
      expect(DEFAULT_SECRET_VARS).toContain("REDIS_URL");
    });
  });
});
