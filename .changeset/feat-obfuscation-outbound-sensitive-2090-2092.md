---
"secureflow": minor
---

feat(rules): add deterministic obfuscation, outbound destination, and sensitive filename detection (#2090 #2091 #2092)

## Obfuscation Detection (#2090)

New rule module `src/lib/rules/obfuscation-rules.ts` with rule IDs:
- `SEC_OBFUSC_DECODE_EXECUTE` — detects decode-and-execute patterns (`eval(atob(...))`, `exec(base64.b64decode(...))`, `Function(...)`, `eval(Buffer.from(...))`, PHP `eval(gzinflate(...))`)
- `SEC_OBFUSC_LONG_BASE64_BLOB` — detects very long (≥ 200 chars) contiguous base64 strings not preceded by a data-URI prefix
- `SEC_OBFUSC_LONG_HEX_BLOB` — detects very long (≥ 200 chars) contiguous hex strings

Rules are skipped for lockfiles and configurable ignore paths. Minimum blob length is configurable.

## Outbound Destination Detection (#2091)

New rule module `src/lib/rules/outbound-rules.ts` with rule IDs:
- `SEC_OUTBOUND_RAW_IP` — detects raw IPv4 addresses in added lines (excludes RFC-1918 private ranges, loopback, and link-local)
- `SEC_OUTBOUND_URL_SHORTENER` — detects URLs using well-known shortening services (bit.ly, t.co, tinyurl, etc.)
- `SEC_OUTBOUND_PASTE_SITE` — detects URLs using paste / file-sharing sites (pastebin.com, hastebin, file.io, etc.)

Custom allowed hosts configurable via `allowedHosts` in `.secureflow.json`.

## Sensitive Filename Detection (#2092)

New rule module `src/lib/rules/sensitive-file-rules.ts` with rule ID:
- `SEC_SENSITIVE_FILE_NAME` — detects committed files whose name or extension indicates secrets (`.env`, `id_rsa`, `.pem`, `.key`, `.p12`, `.sqlite`, etc.)

Example/sample variants (`.env.example`, `.env.sample`, `.env.template`) are explicitly excluded. Custom allow-lists supported via `allowedFilenames` / `allowedPatterns`.

## Integration

All three rule sets are integrated into the main scan pipeline (`src/lib/armor/scanner.ts` and `src/lib/scanner/scanEngine.ts`) and exported from the public scanner API. Rules run deterministically on added lines only and their findings are merged with LLM findings via fingerprint deduplication.

## Tests

69 new unit tests covering all rule IDs, boundary conditions, ignore/allow overrides, and disabled-rule configurations:
- `src/lib/rules/obfuscation-rules.test.ts` (16 tests)
- `src/lib/rules/outbound-rules.test.ts` (17 tests)
- `src/lib/rules/sensitive-file-rules.test.ts` (36 tests)
