---
"secureflow": minor
---

Scope policies to paths in `.secureflow.json` for monorepos (#1868). Extends `.secureflow.json` with an optional `policyScopes` list where each entry specifies file path globs and either `enable` or `disable` lists of policy names. Files matching a scope only receive the policies allowed for that scope before the diff is sent to the scanner. Scopes are read exclusively from the base branch, invalid globs and unknown policies produce warnings without crashing scans, and applied scopes are reported in pull request comments.
