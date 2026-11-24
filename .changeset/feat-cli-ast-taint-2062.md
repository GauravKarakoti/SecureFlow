---
"secureflow-cli": minor
---

feat(rules): AST-based semantic taint analysis for unescaped template string and dynamic query construction in CLI scanner (#2062)

- Added `cli/src/ast-analyzer.ts` implementing intra-procedural AST taint propagation tracking sources (`process.env`, secret identifiers, user input) into sensitive sinks (database queries, shell executions, and credential loggers).
- Added detection for rule `SECUREFLOW-010` (dynamic database query construction with unescaped taint), `SECUREFLOW-011` (credential identifier logged via template/concatenation), and `SECUREFLOW-012` (shell command execution taint).
- Added sanitizer recognition (`maskSecret`, `redact`, `hash`, `encodeURIComponent`, `escape`) to eliminate false positives on sanitized expressions.
- Integrated AST taint scanning seamlessly into `scanFile` for `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, and `.cjs` source files with full inline suppression support.
