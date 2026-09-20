---
"secureflow": patch
---

`AuditSanitizer.serializePayload` now preserves `Date` values. `JSON.stringify` converts a Date with `toJSON()` before the replacer sees it, so the `instanceof Date` branch never matched and Dates came back from `deserializePayload` as plain strings. The replacer now reads the original value.
