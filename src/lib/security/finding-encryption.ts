/**
 * AES-256-GCM encryption at rest for sensitive finding fields (#2016).
 *
 * Encrypts `codeSnippet` and `explanation` columns with authenticated AES-256-GCM
 * using a key configured via `ENCRYPTION_KEY` (supporting the `_FILE` pattern).
 * A key ID is stored per row (both in the database column `encryptionKeyId` and
 * in the serialized ciphertext payload header), enabling zero-downtime key rotation.
 *
 * Storage format:
 *   `enc:<keyId>:aes-256-gcm:<ivBase64>:<tagBase64>:<ciphertextBase64>`
 *
 * Non-encrypted fields (type, severity, fileLocation, line numbers, CWE, tags)
 * remain in plaintext so database indexes, search, and filtering continue working.
 */

import crypto from "node:crypto";
import { resolveSecretValue } from "@/lib/secret-config";

export const DEFAULT_KEY_ID = "v1";
export const ENCRYPTION_PREFIX = "enc:";
export const CIPHER_ALGORITHM = "aes-256-gcm";
export const GCM_IV_LENGTH_BYTES = 12;
export const GCM_TAG_LENGTH_BYTES = 16;

export class DecryptionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DecryptionError";
  }
}

/** In-memory keyring registry mapping key ID to 32-byte cryptographic keys. */
const keyring = new Map<string, Buffer>();

/**
 * Normalizes an arbitrary secret string or buffer into a strictly 32-byte (256-bit) key.
 *
 * - 64 hex characters -> parsed as 32-byte hex.
 * - 44 base64 characters representing 32 bytes -> parsed as base64.
 * - Exact 32-byte UTF-8 string or Buffer -> used directly.
 * - Any other length -> deterministically hashed with SHA-256 to produce 32 bytes.
 */
export function derive32ByteKey(raw: string | Buffer): Buffer {
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 32) return Buffer.from(raw);
    return crypto.createHash("sha256").update(raw).digest();
  }

  const str = String(raw).trim();
  if (!str) {
    throw new Error("Encryption key cannot be empty.");
  }

  // 64-char hex string (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    return Buffer.from(str, "hex");
  }

  // 44-char base64 string ending with = or raw base64 (32 bytes)
  if (/^[A-Za-z0-9+/]{43}=?$/.test(str) || /^[A-Za-z0-9+/]{44}$/.test(str)) {
    try {
      const buf = Buffer.from(str, "base64");
      if (buf.length === 32) return buf;
    } catch {
      // Fall through to SHA-256 derivation
    }
  }

  // Exact 32 bytes ASCII/UTF-8
  const utf8Buf = Buffer.from(str, "utf8");
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  // Hash arbitrary passphrase/secret into 32 bytes
  return crypto.createHash("sha256").update(str, "utf8").digest();
}

/**
 * Registers an encryption key into the keyring for a specific key ID.
 */
export function registerEncryptionKey(keyId: string, rawKey: string | Buffer): void {
  const normalizedKey = derive32ByteKey(rawKey);
  keyring.set(keyId, normalizedKey);
}

/**
 * Clears the in-memory keyring.
 */
export function clearKeyring(): void {
  keyring.clear();
}

/**
 * Checks whether findings encryption is enabled.
 * Opt-in via `ENCRYPTION_ENABLED=true` or `FINDINGS_ENCRYPTION_ENABLED=true`.
 */
export function isFindingEncryptionEnabled(
  source: Record<string, string | undefined> = process.env,
): boolean {
  return (
    source.ENCRYPTION_ENABLED === "true" ||
    source.ENCRYPTION_ENABLED === "1" ||
    source.FINDINGS_ENCRYPTION_ENABLED === "true" ||
    source.FINDINGS_ENCRYPTION_ENABLED === "1"
  );
}

/**
 * Returns the active key ID for newly encrypted rows.
 */
export function getActiveKeyId(source: Record<string, string | undefined> = process.env): string {
  return source.ENCRYPTION_KEY_ID?.trim() || DEFAULT_KEY_ID;
}

/**
 * Resolves the primary encryption key from environment or file secret.
 */
export function resolvePrimaryEncryptionKey(
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  return resolveSecretValue("ENCRYPTION_KEY", source);
}

/**
 * Loads and registers keys from environment variables and configured files into the keyring.
 */
export function loadKeyringFromEnv(source: Record<string, string | undefined> = process.env): void {
  const activeKeyId = getActiveKeyId(source);
  const primaryKey = resolvePrimaryEncryptionKey(source);

  if (primaryKey) {
    registerEncryptionKey(activeKeyId, primaryKey);
  }

  // Load additional keys for rotation from ENCRYPTION_KEYS (JSON or CSV format)
  const additionalKeysRaw = resolveSecretValue("ENCRYPTION_KEYS", source) || source.ENCRYPTION_KEYS;

  if (additionalKeysRaw) {
    try {
      const parsed = JSON.parse(additionalKeysRaw);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [id, keyVal] of Object.entries(parsed)) {
          if (typeof keyVal === "string" && keyVal.trim()) {
            registerEncryptionKey(id, keyVal);
          }
        }
      }
    } catch {
      // Try CSV format: "v1:key1,v2:key2"
      const pairs = additionalKeysRaw.split(",");
      for (const pair of pairs) {
        const [id, keyVal] = pair.split(":").map((p) => p.trim());
        if (id && keyVal) {
          registerEncryptionKey(id, keyVal);
        }
      }
    }
  }
}

/**
 * Retrieves the 32-byte key buffer for a given key ID from the keyring or environment.
 */
export function getEncryptionKey(keyId: string): Buffer | undefined {
  if (keyring.has(keyId)) {
    return keyring.get(keyId);
  }

  // Lazy-load from env if not in keyring
  loadKeyringFromEnv();
  return keyring.get(keyId);
}

/**
 * Validates the encryption configuration at startup.
 * Throws a clear error when encryption is enabled without a key.
 */
export function validateFindingEncryptionConfig(
  source: Record<string, string | undefined> = process.env,
): void {
  if (!isFindingEncryptionEnabled(source)) {
    return;
  }

  const primaryKey = resolvePrimaryEncryptionKey(source);
  if (!primaryKey || primaryKey.trim() === "") {
    throw new Error(
      "❌ Startup failed: Finding encryption is enabled (ENCRYPTION_ENABLED=true), but ENCRYPTION_KEY (or ENCRYPTION_KEY_FILE) is missing or empty. Please set ENCRYPTION_KEY.",
    );
  }

  try {
    derive32ByteKey(primaryKey);
  } catch (err) {
    throw new Error(
      `❌ Startup failed: Invalid ENCRYPTION_KEY provided: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Checks whether a text string is encrypted with SecureFlow's AES-256-GCM payload format.
 */
export function isEncrypted(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  return text.startsWith(ENCRYPTION_PREFIX) && text.includes(`:${CIPHER_ALGORITHM}:`);
}

export interface ParsedEncryptedPayload {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * Parses an encrypted payload string into its cryptographic components.
 */
export function parseEncryptedPayload(text: string): ParsedEncryptedPayload | null {
  if (!isEncrypted(text)) return null;

  // enc:<keyId>:aes-256-gcm:<ivBase64>:<tagBase64>:<cipherBase64>
  const parts = text.split(":");
  if (parts.length !== 6) return null;

  const [, keyId, algorithm, ivBase64, tagBase64, cipherBase64] = parts;
  if (algorithm !== CIPHER_ALGORITHM) return null;

  try {
    const iv = Buffer.from(ivBase64, "base64");
    const tag = Buffer.from(tagBase64, "base64");
    const ciphertext = Buffer.from(cipherBase64, "base64");

    if (iv.length !== GCM_IV_LENGTH_BYTES || tag.length !== GCM_TAG_LENGTH_BYTES) {
      return null;
    }

    return { keyId, iv, tag, ciphertext };
  } catch {
    return null;
  }
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * If the string is already encrypted, returns it unchanged to prevent double-encryption.
 */
export function encryptText(
  plainText: string | null | undefined,
  options?: { keyId?: string; key?: Buffer | string },
): string | null {
  if (plainText === null || plainText === undefined) {
    return null;
  }

  if (typeof plainText !== "string" || plainText === "") {
    return plainText;
  }

  // Avoid double-encryption
  if (isEncrypted(plainText)) {
    return plainText;
  }

  const keyId = options?.keyId ?? getActiveKeyId();
  let keyBuf: Buffer | undefined;

  if (options?.key) {
    keyBuf = derive32ByteKey(options.key);
  } else {
    keyBuf = getEncryptionKey(keyId);
    if (!keyBuf) {
      const primary = resolvePrimaryEncryptionKey();
      if (primary) {
        registerEncryptionKey(keyId, primary);
        keyBuf = getEncryptionKey(keyId);
      }
    }
  }

  if (!keyBuf) {
    throw new Error(
      `Cannot encrypt: encryption key with ID "${keyId}" not found. Configure ENCRYPTION_KEY or register key in keyring.`,
    );
  }

  const iv = crypto.randomBytes(GCM_IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, keyBuf, iv);

  // Authenticate keyId as additional authenticated data (AAD) to prevent key-swap attacks
  cipher.setAAD(Buffer.from(keyId, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${keyId}:${CIPHER_ALGORITHM}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload back to plaintext.
 *
 * If the input is not encrypted, returns it directly as plaintext for transparent backwards compatibility.
 */
export function decryptText(
  cipherText: string | null | undefined,
  options?: { keyId?: string; key?: Buffer | string },
): string | null {
  if (cipherText === null || cipherText === undefined) {
    return null;
  }

  if (typeof cipherText !== "string" || cipherText === "") {
    return cipherText;
  }

  if (!isEncrypted(cipherText)) {
    return cipherText; // Return unencrypted text directly
  }

  const parsed = parseEncryptedPayload(cipherText);
  if (!parsed) {
    throw new DecryptionError("Malformed encrypted payload format.");
  }

  const keyId = options?.keyId ?? parsed.keyId;
  let keyBuf: Buffer | undefined;

  if (options?.key) {
    keyBuf = derive32ByteKey(options.key);
  } else {
    keyBuf = getEncryptionKey(keyId);
  }

  if (!keyBuf) {
    throw new DecryptionError(
      `Cannot decrypt: unknown encryption key ID "${keyId}". Ensure previous keys are retained during rotation.`,
    );
  }

  try {
    const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, keyBuf, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    // Bind AAD matching encryption
    decipher.setAAD(Buffer.from(parsed.keyId, "utf8"));

    const decrypted = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    throw new DecryptionError(
      `Decryption failed for key ID "${keyId}": authentication tag mismatch or invalid key.`,
      err,
    );
  }
}

/**
 * Transparently encrypts a finding's sensitive fields (`codeSnippet` and `explanation`)
 * and attaches the active `encryptionKeyId`.
 *
 * If encryption is disabled and `force` is false, returns finding as-is.
 */
export function encryptFinding<
  T extends {
    codeSnippet?: string | null;
    explanation?: string | null;
    encryptionKeyId?: string | null;
    [key: string]: unknown;
  },
>(finding: T, options?: { keyId?: string; force?: boolean }): T {
  if (!finding) return finding;

  const shouldEncrypt = options?.force || isFindingEncryptionEnabled();
  if (!shouldEncrypt) {
    return finding;
  }

  const keyId = options?.keyId ?? getActiveKeyId();
  const encryptedSnippet =
    finding.codeSnippet !== undefined ? encryptText(finding.codeSnippet, { keyId }) : undefined;
  const encryptedExplanation =
    finding.explanation !== undefined ? encryptText(finding.explanation, { keyId }) : undefined;

  return {
    ...finding,
    ...(encryptedSnippet !== undefined ? { codeSnippet: encryptedSnippet } : {}),
    ...(encryptedExplanation !== undefined ? { explanation: encryptedExplanation } : {}),
    encryptionKeyId: keyId,
  };
}

/**
 * Transparently decrypts a finding's sensitive fields (`codeSnippet` and `explanation`).
 * If they are not encrypted, returns them untouched.
 */
export function decryptFinding<
  T extends {
    codeSnippet?: string | null;
    explanation?: string | null;
    encryptionKeyId?: string | null;
    [key: string]: unknown;
  },
>(finding: T): T {
  if (!finding) return finding;

  const decryptedSnippet =
    finding.codeSnippet !== undefined
      ? decryptText(finding.codeSnippet, { keyId: finding.encryptionKeyId ?? undefined })
      : undefined;

  const decryptedExplanation =
    finding.explanation !== undefined
      ? decryptText(finding.explanation, { keyId: finding.encryptionKeyId ?? undefined })
      : undefined;

  return {
    ...finding,
    ...(decryptedSnippet !== undefined ? { codeSnippet: decryptedSnippet } : {}),
    ...(decryptedExplanation !== undefined ? { explanation: decryptedExplanation } : {}),
  };
}

/**
 * Batch-decrypts an array of findings.
 */
export function decryptFindings<
  T extends {
    codeSnippet?: string | null;
    explanation?: string | null;
    encryptionKeyId?: string | null;
    [key: string]: unknown;
  },
>(findings: T[]): T[] {
  if (!Array.isArray(findings)) return findings;
  return findings.map((f) => decryptFinding(f));
}

export interface RotationResult {
  totalScanned: number;
  reencryptedCount: number;
  skippedCount: number;
  failedCount: number;
  targetKeyId: string;
}

/**
 * Re-encrypts an individual finding from an older key (or unencrypted) to a target key.
 */
export function reencryptFindingData(
  finding: {
    codeSnippet?: string | null;
    explanation?: string | null;
    encryptionKeyId?: string | null;
  },
  targetKeyId: string = getActiveKeyId(),
): {
  codeSnippet: string | null;
  explanation: string | null;
  encryptionKeyId: string;
} {
  const plainSnippet = decryptText(finding.codeSnippet, {
    keyId: finding.encryptionKeyId ?? undefined,
  });
  const plainExplanation = decryptText(finding.explanation, {
    keyId: finding.encryptionKeyId ?? undefined,
  });

  const newSnippet = encryptText(plainSnippet, { keyId: targetKeyId });
  const newExplanation = encryptText(plainExplanation, { keyId: targetKeyId });

  return {
    codeSnippet: newSnippet,
    explanation: newExplanation,
    encryptionKeyId: targetKeyId,
  };
}

/**
 * Rotates findings in batches: re-encrypts rows encrypted under old keys
 * (or unencrypted rows) to the target key ID without downtime (#2016).
 */
export async function rotateFindingsBatch(
  prisma: any,
  options: {
    batchSize?: number;
    targetKeyId?: string;
    dryRun?: boolean;
    onProgress?: (stats: { processed: number; reencrypted: number }) => void;
  } = {},
): Promise<RotationResult> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const targetKeyId = options.targetKeyId ?? getActiveKeyId();
  const dryRun = Boolean(options.dryRun);

  let totalScanned = 0;
  let reencryptedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let cursor: string | undefined = undefined;

  while (true) {
    const batch: any[] = await prisma.finding.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      where: {
        OR: [{ encryptionKeyId: null }, { encryptionKeyId: { not: targetKeyId } }],
      },
      select: {
        id: true,
        codeSnippet: true,
        explanation: true,
        encryptionKeyId: true,
      },
    });

    if (!batch || batch.length === 0) {
      break;
    }

    totalScanned += batch.length;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      const needsSnippetReencrypt = row.codeSnippet !== null && row.codeSnippet !== "";
      const needsExplanationReencrypt = row.explanation !== null && row.explanation !== "";

      if (
        !needsSnippetReencrypt &&
        !needsExplanationReencrypt &&
        row.encryptionKeyId === targetKeyId
      ) {
        skippedCount++;
        continue;
      }

      try {
        const reencrypted = reencryptFindingData(row, targetKeyId);

        if (!dryRun) {
          await prisma.finding.update({
            where: { id: row.id },
            data: {
              codeSnippet: reencrypted.codeSnippet,
              explanation: reencrypted.explanation,
              encryptionKeyId: reencrypted.encryptionKeyId,
            },
          });
        }
        reencryptedCount++;
      } catch (err) {
        failedCount++;
        console.error(`[EncryptionRotation] Failed to re-encrypt finding ${row.id}:`, err);
      }
    }

    if (options.onProgress) {
      options.onProgress({ processed: totalScanned, reencrypted: reencryptedCount });
    }

    if (batch.length < batchSize) {
      break;
    }
  }

  return {
    totalScanned,
    reencryptedCount,
    skippedCount,
    failedCount,
    targetKeyId,
  };
}
