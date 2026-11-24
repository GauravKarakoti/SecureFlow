---
"secureflow": minor
---

feat(security): encrypt stored code snippets and explanations at rest with an application key (#2016)

- Encrypted `codeSnippet` and `explanation` columns in Findings table with AES-256-GCM using `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE`.
- Stored `encryptionKeyId` per row for unambiguous key mapping and seamless key rotation.
- Added transparent decryption on finding reads via Prisma query extension and API/actions endpoints.
- Maintained backward compatibility for existing unencrypted findings.
- Added CLI migration script (`scripts/migrate-encrypt-findings.ts`) to encrypt existing records in batches.
- Provided comprehensive documentation for zero-downtime key rotation (`docs/security/finding-encryption.md`).
- Added strict startup validation failing clearly if encryption is enabled without a valid encryption key.
