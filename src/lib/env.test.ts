import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { formatEnvErrors, validateEnv } from "./env";

const validPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3y
-----END RSA PRIVATE KEY-----`;

const validEnv = {
  DATABASE_URL: "postgres://localhost/test",
  DATABASE_POOL_URL: "postgres://localhost/test",
  GROQ_API_KEY: "test-groq-super-secret-key-12345",
  GITHUB_APP_ID: "123",
  GITHUB_WEBHOOK_SECRET: "webhook-secret-98765",
  GITHUB_PRIVATE_KEY: validPrivateKey,
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret-abcde",
  AUTH_SECRET: "auth-secret-top-secret-54321",
  AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

describe("environment validation (src/lib/env.ts)", () => {
  it("accepts valid environment variables", () => {
    expect(validateEnv(validEnv)).toMatchObject(validEnv);
  });

  it("accepts valid private key with literal \\n sequences", () => {
    const envWithEscapedNewlines = {
      ...validEnv,
      GITHUB_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nMIIEowIBAAKCAQEA\\n-----END PRIVATE KEY-----",
    };
    expect(validateEnv(envWithEscapedNewlines)).toBeDefined();
  });

  it("fails fast on missing required variables with a clear message naming them", () => {
    const { GROQ_API_KEY, DATABASE_URL, ...incompleteEnv } = validEnv;

    expect(() => validateEnv(incompleteEnv)).toThrowError(/DATABASE_URL/);
    expect(() => validateEnv(incompleteEnv)).toThrowError(/GROQ_API_KEY/);
  });

  it("rejects invalid or malformed private keys (e.g. missing header/footer)", () => {
    const invalidKeyEnv = {
      ...validEnv,
      GITHUB_PRIVATE_KEY: "broken-private-key-without-header-or-footer",
    };

    expect(() => validateEnv(invalidKeyEnv)).toThrowError(/Invalid private key format/);
  });

  it("rejects negative or non-numeric TRUSTED_PROXY_HOP_COUNT", () => {
    const negativeHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "-1",
    };
    expect(() => validateEnv(negativeHopEnv)).toThrowError(
      /TRUSTED_PROXY_HOP_COUNT must be a non-negative integer/,
    );

    const nonNumericHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "invalid_hops",
    };
    expect(() => validateEnv(nonNumericHopEnv)).toThrowError(
      /TRUSTED_PROXY_HOP_COUNT must be a non-negative integer/,
    );

    const floatHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "1.5",
    };
    expect(() => validateEnv(floatHopEnv)).toThrowError(
      /TRUSTED_PROXY_HOP_COUNT must be a non-negative integer/,
    );
  });

  it("accepts valid TRUSTED_PROXY_HOP_COUNT", () => {
    const validHopEnv = {
      ...validEnv,
      TRUSTED_PROXY_HOP_COUNT: "2",
    };
    expect(validateEnv(validHopEnv).TRUSTED_PROXY_HOP_COUNT).toBe("2");
  });

  it("rejects malformed URLs for AUTH_URL and NEXT_PUBLIC_APP_URL", () => {
    const badUrlEnv = {
      ...validEnv,
      AUTH_URL: "not-a-valid-url",
    };
    expect(() => validateEnv(badUrlEnv)).toThrowError(/AUTH_URL must be a valid URL/);
  });

  it("never prints secret values in error messages", () => {
    const badSecretEnv = {
      ...validEnv,
      GROQ_API_KEY: "", // invalid empty string
      GITHUB_PRIVATE_KEY: "malformed-secret-private-key-data-123456789",
      AUTH_SECRET: "",
    };

    try {
      validateEnv(badSecretEnv);
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      expect(err.message).not.toContain("malformed-secret-private-key-data-123456789");
      expect(err.message).toContain("GITHUB_PRIVATE_KEY");
      expect(err.message).toContain("[value redacted]");
    }
  });

  it("redacts SMTP_PASS and BREVO_API_KEY if validation errors occur", () => {
    const issues = [
      {
        code: "custom" as const,
        path: ["SMTP_PASS"],
        message: "Invalid secret",
      },
      {
        code: "custom" as const,
        path: ["BREVO_API_KEY"],
        message: "Invalid secret",
      },
    ];
    const formatted = formatEnvErrors(issues as any, {
      SMTP_PASS: "super-secret-smtp-password",
      BREVO_API_KEY: "xkeysib-super-secret-brevo-api-key",
    });
    expect(formatted).not.toContain("super-secret-smtp-password");
    expect(formatted).not.toContain("xkeysib-super-secret-brevo-api-key");
    expect(formatted).toContain("[value redacted]");
  });

  it("allows optional variables to be omitted", () => {
    expect(validateEnv(validEnv)).toBeDefined();
  });

  it("validates AI_PROVIDER and accepts supported providers", () => {
    for (const provider of ["groq", "ollama", "vllm", "openai", "custom"]) {
      const validAiEnv = {
        ...validEnv,
        AI_PROVIDER: provider,
      };
      expect(validateEnv(validAiEnv).AI_PROVIDER).toBe(provider);
    }
  });

  it("rejects invalid AI_PROVIDER with clear error", () => {
    const invalidAiEnv = {
      ...validEnv,
      AI_PROVIDER: "invalid_provider",
    };
    expect(() => validateEnv(invalidAiEnv)).toThrowError(
      /AI_PROVIDER must be one of: groq, ollama, vllm, openai, custom/,
    );
  });

  it("validates AI_BASE_URL and rejects malformed URLs", () => {
    const badBaseUrlEnv = {
      ...validEnv,
      AI_BASE_URL: "not-a-valid-http-url",
    };
    expect(() => validateEnv(badBaseUrlEnv)).toThrowError(
      /AI_BASE_URL must be a valid HTTP or HTTPS URL/,
    );

    const validBaseUrlEnv = {
      ...validEnv,
      AI_BASE_URL: "http://localhost:11434/v1",
    };
    expect(validateEnv(validBaseUrlEnv).AI_BASE_URL).toBe("http://localhost:11434/v1");
  });

  it("validates AI_MODEL and rejects empty string", () => {
    const emptyModelEnv = {
      ...validEnv,
      AI_MODEL: "",
    };
    expect(() => validateEnv(emptyModelEnv)).toThrowError(/AI_MODEL cannot be empty if specified/);

    const validModelEnv = {
      ...validEnv,
      AI_MODEL: "llama3.3",
    };
    expect(validateEnv(validModelEnv).AI_MODEL).toBe("llama3.3");
  });

  describe("GitHub Enterprise Server environment validation", () => {
    it("defaults GITHUB_API_URL to https://api.github.com when not supplied", () => {
      const parsed = validateEnv(validEnv);
      expect(parsed.GITHUB_API_URL).toBe("https://api.github.com");
      expect(parsed.GITHUB_WEB_URL).toBeUndefined();
    });

    it("accepts custom GITHUB_API_URL and GITHUB_WEB_URL", () => {
      const parsed = validateEnv({
        ...validEnv,
        GITHUB_API_URL: "https://ghe.mycorp.com/api/v3",
        GITHUB_WEB_URL: "https://ghe.mycorp.com",
      });
      expect(parsed.GITHUB_API_URL).toBe("https://ghe.mycorp.com/api/v3");
      expect(parsed.GITHUB_WEB_URL).toBe("https://ghe.mycorp.com");
    });

    it("rejects non-HTTPS GITHUB_API_URL in production mode", () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          NODE_ENV: "production",
          GITHUB_API_URL: "http://ghe.mycorp.com/api/v3",
        }),
      ).toThrowError(/GITHUB_API_URL must use HTTPS in production/);
    });

    it("rejects non-HTTPS GITHUB_WEB_URL in production mode", () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          NODE_ENV: "production",
          GITHUB_WEB_URL: "http://ghe.mycorp.com",
        }),
      ).toThrowError(/GITHUB_WEB_URL must use HTTPS in production/);
    });

    it("allows non-HTTPS GITHUB_API_URL in development mode", () => {
      const parsed = validateEnv({
        ...validEnv,
        NODE_ENV: "development",
        GITHUB_API_URL: "http://localhost:8080/api/v3",
      });
      expect(parsed.GITHUB_API_URL).toBe("http://localhost:8080/api/v3");
    });

    it("rejects malformed GITHUB_API_URL", () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          GITHUB_API_URL: "not-a-valid-url",
        }),
      ).toThrowError(/GITHUB_API_URL must be a valid URL/);
    });
  });

  describe("file-based secrets validation (<NAME>_FILE) (#1893)", () => {
    it("successfully validates and populates secrets supplied via <NAME>_FILE", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-env-test-"));
      try {
        const groqFile = path.join(tempDir, "groq_key.txt");
        const keyFile = path.join(tempDir, "key.pem");
        const authFile = path.join(tempDir, "auth.txt");

        fs.writeFileSync(groqFile, "gsk_file_supplied_groq_api_key_12345\n", "utf8");
        fs.writeFileSync(keyFile, `${validPrivateKey}\n`, "utf8");
        fs.writeFileSync(authFile, "file_supplied_auth_secret_99999\r\n", "utf8");

        const { GROQ_API_KEY, GITHUB_PRIVATE_KEY, AUTH_SECRET, ...baseEnv } = validEnv;

        const envWithFiles = {
          ...baseEnv,
          GROQ_API_KEY_FILE: groqFile,
          GITHUB_PRIVATE_KEY_FILE: keyFile,
          AUTH_SECRET_FILE: authFile,
        };

        const result = validateEnv(envWithFiles);
        expect(result.GROQ_API_KEY).toBe("gsk_file_supplied_groq_api_key_12345");
        expect(result.GITHUB_PRIVATE_KEY).toBe(validPrivateKey);
        expect(result.AUTH_SECRET).toBe("file_supplied_auth_secret_99999");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects startup when both direct variable and _FILE are specified", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-env-test-"));
      try {
        const dbFile = path.join(tempDir, "db.txt");
        fs.writeFileSync(dbFile, "postgres://localhost/file-db\n", "utf8");

        const envWithBoth = {
          ...validEnv,
          DATABASE_URL_FILE: dbFile,
        };

        expect(() => validateEnv(envWithBoth)).toThrowError(
          /Cannot specify both DATABASE_URL and DATABASE_URL_FILE/,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects startup when a _FILE points to a non-existent file", () => {
      const envWithMissing = {
        ...validEnv,
        GROQ_API_KEY: undefined,
        GROQ_API_KEY_FILE: "/path/that/does/not/exist/at/all/secret.txt",
      };

      expect(() => validateEnv(envWithMissing)).toThrowError(
        /Failed to read secret for GROQ_API_KEY from GROQ_API_KEY_FILE/,
      );
    });

    it("rejects startup when ENCRYPTION_ENABLED is true without ENCRYPTION_KEY (#2016)", () => {
      const envWithEncryptionNoKey = {
        ...validEnv,
        ENCRYPTION_ENABLED: "true",
      };

      expect(() => validateEnv(envWithEncryptionNoKey)).toThrowError(
        /ENCRYPTION_KEY is required when encryption is enabled/,
      );
    });

    it("accepts startup when ENCRYPTION_ENABLED is true with ENCRYPTION_KEY (#2016)", () => {
      const envWithEncryptionAndKey = {
        ...validEnv,
        ENCRYPTION_ENABLED: "true",
        ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };

      const result = validateEnv(envWithEncryptionAndKey);
      expect(result.ENCRYPTION_ENABLED).toBe("true");
      expect(result.ENCRYPTION_KEY).toBe(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      );
    });

    it("resolves ENCRYPTION_KEY from ENCRYPTION_KEY_FILE when encryption is enabled (#2016)", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secureflow-encryption-test-"));
      try {
        const keyFile = path.join(tempDir, "encryption_key.txt");
        const keyVal = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        fs.writeFileSync(keyFile, `${keyVal}\n`, "utf8");

        const envWithKeyFile = {
          ...validEnv,
          ENCRYPTION_ENABLED: "true",
          ENCRYPTION_KEY_FILE: keyFile,
        };

        const result = validateEnv(envWithKeyFile);
        expect(result.ENCRYPTION_KEY).toBe(keyVal);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
