---
"secureflow": minor
---

feat(cli): add scan progress indicator, --quiet, and --verbose flags

- Display real-time progress indicator on stderr during file scanning when attached to an interactive terminal, automatically disabled when output is piped or redirected.
- Add `--quiet` (`-q`) flag to suppress progress, spinners, and informational logs, outputting only scan summaries and errors.
- Add `--verbose` flag to display per-file execution timing and skipped file details.
- Disallow combining `--quiet` and `--verbose` with a clear usage error.
