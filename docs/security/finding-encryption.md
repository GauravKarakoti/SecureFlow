# Finding Encryption at Rest & Key Rotation Guide (#2016)

SecureFlow supports authenticated AES-256-GCM encryption at rest for sensitive finding content (`codeSnippet` and `explanation`). This prevents sensitive source code fragments and vulnerability explanations from being exposed in plaintext in the event of a database dump or backup leak.

Non-sensitive columns (`severity`, `type`, `fileLocation`, `lineStart`, `cwe`, `tag`, `isBaseline`, `createdAt`) remain stored as plaintext, preserving database index performance, query filtering, and analytics.

---

## 1. Enabling Encryption (Opt-in)

Encryption is opt-in via environment variables.

```bash
# Enable encryption
ENCRYPTION_ENABLED=true

# 32-byte (256-bit) encryption key: 64-char hex, 44-char base64, or 32-byte string
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# Key identifier stored per row (default: "v1")
ENCRYPTION_KEY_ID="v1"
```

### Docker & Kubernetes `_FILE` Pattern

SecureFlow supports the `_FILE` pattern across all application secrets:

```bash
ENCRYPTION_ENABLED=true
ENCRYPTION_KEY_FILE=/run/secrets/finding_encryption_key
ENCRYPTION_KEY_ID=v1
```

> **Note**: If `ENCRYPTION_ENABLED=true` is set without a corresponding `ENCRYPTION_KEY` or `ENCRYPTION_KEY_FILE`, the application will fail startup immediately with a clear configuration error.

---

## 2. Storage Format

Encrypted columns are stored using the self-describing payload format:

```
enc:<keyId>:aes-256-gcm:<ivBase64>:<tagBase64>:<ciphertextBase64>
```

- `keyId`: The key identifier used to encrypt the payload.
- `ivBase64`: 12-byte (96-bit) unique initialization vector generated with cryptographically secure random bytes (`crypto.randomBytes(12)`).
- `tagBase64`: 16-byte (128-bit) GCM authentication tag for tamper detection and integrity verification.
- `ciphertextBase64`: The authenticated ciphertext payload.
- In addition, the `Finding.encryptionKeyId` column records the active key ID for fast SQL filtering during rotation.

---

## 3. Zero-Downtime Key Rotation Procedure

To rotate encryption keys without application downtime or service interruption:

### Step 1: Generate a new 256-bit encryption key

```bash
openssl rand -hex 32
# Output: e.g. b4c18f7...92a1
```

### Step 2: Deploy new key alongside previous key(s)

Configure the application with the new active key ID while retaining the old key in the keyring:

```bash
ENCRYPTION_ENABLED=true

# Set the new key as primary:
ENCRYPTION_KEY_ID="v2"
ENCRYPTION_KEY="<new_key_hex>"

# Provide the keyring containing both old and new keys:
ENCRYPTION_KEYS='{"v1": "<old_key_hex>", "v2": "<new_key_hex>"}'
```

At this stage:

- All new incoming scans write rows encrypted with `v2`.
- Reads for rows encrypted with `v1` continue decrypting transparently using `v1`.
- Reads for rows encrypted with `v2` decrypt transparently using `v2`.
- **Zero downtime** is experienced.

### Step 3: Run the batch re-encryption script

Run the re-encryption script to migrate existing rows from `v1` (and any legacy plaintext rows) to `v2` in batches:

```bash
# Test first with dry-run
npx tsx scripts/migrate-encrypt-findings.ts --target-key-id v2 --dry-run

# Run migration in batches of 100
npx tsx scripts/migrate-encrypt-findings.ts --target-key-id v2 --batch-size 100
```

### Step 4: Verify completion

Verify in the database that all rows have been updated to `encryptionKeyId = 'v2'`:

```sql
SELECT COUNT(*) FROM "Finding" WHERE "encryptionKeyId" IS NULL OR "encryptionKeyId" != 'v2';
-- Expected result: 0
```

### Step 5: Retire the old key

Once all rows have migrated, remove `v1` from `ENCRYPTION_KEYS` in your production environment.

---

## 4. Migrating Existing Plaintext Findings

For existing installations enabling encryption for the first time:

1. Enable `ENCRYPTION_ENABLED=true` and set `ENCRYPTION_KEY` in environment.
2. Run the migration script:
   ```bash
   npx tsx scripts/migrate-encrypt-findings.ts --batch-size 100
   ```
3. Existing plaintext findings are encrypted in place with the primary key.
