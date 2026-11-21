---
"secureflow-cli": minor
---

Add content hash and ruleset version caching to SecureFlow CLI. Results are stored in `<repoRoot>/.secureflow/cache` keyed by file SHA-256 and ruleset version, skipping unchanged files on repeat scans. Supports `--no-cache` to bypass caching, `secureflow cache-clear` to wipe stored entries, and safely ignores or cleans corrupted cache entries.
