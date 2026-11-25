---
"secureflow": minor
---

feat(rules): detect hidden Unicode characters and homoglyph identifiers in added code (#2089)

Adds a new deterministic rule module (`src/lib/rules/unicode-rules.ts`) that scans only added
lines in pull-request diffs for three classes of invisible/deceptive Unicode attacks:

**SEC_UNICODE_BIDI_CONTROL** – Trojan Source (CVE-2021-42574)
Detects bidirectional override and isolate control characters (U+202A–U+202E, U+2066–U+2069,
U+200E, U+200F, U+061C) that change the visual rendering order of code, making malicious logic
appear as harmless comments or strings. These are flagged as HIGH severity in **all** files,
including documentation, because a bidi override in source code is unambiguously malicious.

**SEC_UNICODE_ZERO_WIDTH** – Invisible zero-width characters (CVE-2021-42694)
Detects zero-width spaces (U+200B), zero-width non-joiners/joiners (U+200C/U+200D), byte-order
marks (U+FEFF), word-joiners (U+2060), soft hyphens (U+00AD) and similar invisible characters
that can alter string values or parser interpretation while remaining invisible in diff views.
Flagged as HIGH severity in code files.

**SEC_UNICODE_HOMOGLYPH_IDENTIFIER** – Look-alike / mixed-script identifiers
Detects identifiers that mix Cyrillic or Greek characters visually identical to Latin letters
(e.g. Cyrillic 'а' U+0430 for Latin 'a', Greek 'ο' U+03BF for Latin 'o') allowing attackers
to introduce shadow variables or function calls that look identical in review.

### Non-Latin file exemption
Documentation, localization, and translation files are excluded from homoglyph/zero-width
checks via a documented allow-list (`docs/**`, `*.md`, `locales/**`, `i18n/**`, `.po`, `.strings`,
etc.). Custom allow patterns can be configured per repository via `.secureflow.json`.

### Configuration (`.secureflow.json`)
```json
{
  "unicode": {
    "enabled": true,
    "disabledRules": ["SEC_UNICODE_HOMOGLYPH_IDENTIFIER"],
    "allowPatterns": ["legacy/unicode/**"]
  }
}
```

### Integration
- Wired into `scanEngine.ts` (`processScanJob`) with fingerprint-based deduplication against LLM findings.
- Wired into `armor/scanner.ts` (`scanPullRequest`) in `allDeterministicFindings`.
- `gate-config.ts` gains `resolveUnicodeRuleOptions()` and new `GateConfig` fields
  `unicodeRulesEnabled` and `unicodeAllowPatterns`.
- All exports re-exported through `armor/scanner.ts`.

### Tests (`src/lib/rules/unicode-rules.test.ts`) – 15 tests all passing
- Bidi controls produce HIGH findings naming code points (U+202E, U+2066, U+2069).
- Zero-width chars produce HIGH findings naming code points (U+200B, U+200D, U+FEFF).
- Cyrillic and Greek homoglyphs in Latin identifiers produce HIGH findings.
- Allowed documentation/localization files are not flagged for homoglyphs.
- Bidi controls are still flagged even in documentation files.
- Custom `allowPatterns` from options are respected.
- `disabledRules` and `enabled: false` both suppress findings correctly.
- Config parsing from `.secureflow.json` via `parseSecureFlowConfig` + `resolveUnicodeRuleOptions`.
- Multi-file runner gathers findings from all files.
