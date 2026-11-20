---
"secureflow": minor
"secureflow-cli": minor
---

feat(cli): integrate repository configuration generator and schema validator into secureflow CLI (#1898)

- Enhanced `secureflow --init` and added `secureflow init` / `secureflow-cli init` to generate `.secureflow.json` and `.secureflowignore` with helpful comments and sensible defaults.
- Added interactive and non-interactive setup with language auto-detection and flags (`--severity`, `--ignore`, `--languages`, `--force`).
- Enforced overwrite safety: existing configuration files are never overwritten without explicit user confirmation or `--force`.
- Added `secureflow validate` / `secureflow-cli validate` to validate `.secureflow.json` and `.secureflowignore` against shared schemas.
- Line-number error reporting: unknown keys, invalid severities, and invalid globs are reported with exact file, line, and column numbers, exiting non-zero on failure.
- Shared schema and comment-stripping parser between server (`gate-config.ts`) and CLI via `secureflow-cli/contracts`.
