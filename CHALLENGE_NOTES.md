# Challenge Notes: Deterministic Secret Pre-Scanner (#1592)

## Overview

Added a deterministic, fast pre-scanner module (`src/lib/armor/precheck.ts`) that intercepts secrets in pull request diffs before LLM analysis. This guarantees deterministic credential detection without requiring external network connectivity or LLM API keys.

## Key Changes

1. **Module `src/lib/armor/precheck.ts`**:
   - `runDeterministicPrecheck(files, options)`: Pure function executing rule-based detection on added diff lines only.
   - Detects all 5 secret families:
     - AWS Access Key IDs (`AKIA`, `ASIA`, `ABIA`, `ACCA` + 16 chars)
     - GitHub Tokens (`ghp_`, `github_pat_`, OAuth/app tokens)
     - Slack Tokens (`xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`)
     - PEM Private Key Headers (`-----BEGIN ... PRIVATE KEY-----`)
     - Quoted Generic Secret Assignments with Shannon entropy validation (entropy >= 3)
   - Secret Redaction: Limits snippet display to at most 4 characters followed by `...[REDACTED]`.
   - Source Attribution: Employs `precheck-deterministic` in `matchedSignatures`.
   - Deduplication: `mergePrecheckWithLlmFindings` prioritizes pre-scan findings over LLM collisions on the same file and line number.
2. **Integration (`src/lib/armor/scanner.ts`)**:
   - Integrated into `ArmorIQScanner.scanPullRequest()` before batch processing.
   - Preserves pre-scan findings even when LLM batches fail or time out.
3. **Tests (`tests/deterministic-secret-precheck.test.ts`)**:
   - Unit tests covering all acceptance criteria under `tests/`.

## Running Tests

```bash
npx vitest run tests/deterministic-secret-precheck.test.ts
```
