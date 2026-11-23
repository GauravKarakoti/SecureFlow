# Configurable Pull-Request Gate (`.secureflow.json`)

SecureFlow allows repository maintainers to configure pull-request policy decision thresholds per repository using a configuration file located at `.secureflow.json` in the repository root.

## Configuration Format

`.secureflow.json` is a JSON document declaring the pull request gate thresholds:

```json
{
  "gate": {
    "blockOn": "HIGH",
    "reviewOn": "MEDIUM",
    "overrides": [
      {
        "type": "SECRET",
        "blockAt": "MEDIUM"
      }
    ]
  }
}
```

### Options & Vocabulary

- **`blockOn` / `blockAt`**: (Optional) Severity threshold that causes a pull request to receive a `BLOCKED` verdict (`failure` check-run conclusion). Accepted values (case-insensitive): `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or `NONE`.
- **`reviewOn` / `reviewAt`**: (Optional) Severity threshold that causes a pull request to receive a `REVIEW REQUIRED` verdict (`action_required` check-run conclusion). Accepted values (case-insensitive): `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or `NONE`.
- **`NONE`**: Disables that specific threshold level.
- **`overrides`**: (Optional) Type-specific gate overrides matching finding types (e.g., `SECRET`, `VULNERABILITY`, `MISCONFIG`) case-insensitively.

## Defaults

When `.secureflow.json` is not present, the default gate is enforced:

- **`blockOn`**: `CRITICAL`
- **`reviewOn`**: `MEDIUM`
- **Overrides**: None

Findings whose severity cannot be parsed always route to `REVIEW REQUIRED` so that human reviewers can investigate.

## Trust Anchor

To prevent pull request authors from tampering with their own security gate:

- `.secureflow.json` is loaded exclusively from the pull request's **base branch** (e.g., `main` or `develop`).
- A pull request that modifies, relaxes, or deletes `.secureflow.json` on its head branch is evaluated against the base branch's configuration.

## Safe Failure

Security scans must never fail because of configuration errors.

- Missing configuration (404), invalid JSON syntax, schema type violations, or network timeouts safely fall back to the default gate.
- If one key contains an unknown value, that key falls back to its default while the remaining valid keys are preserved.
- A warning is recorded in the application logs whenever a fallback occurs.

## Scan Visibility

When a repository configures a custom gate that differs from default behavior, the check-run summary includes an annotation:

```text
Gate: block on HIGH+, review on MEDIUM+ (from base branch)
```

When default thresholds apply, the check-run output remains standard.

## Path-scoped rules (`gate.paths`)

A maintainer can hold some directories to a stricter or looser gate than the rest of the
repository by adding an optional `paths` array to `gate` in `.secureflow.json`:

```json
{
  "gate": {
    "blockOn": "CRITICAL",
    "paths": [
      { "glob": "infra/**", "blockOn": "MEDIUM" },
      { "glob": "tests/**", "blockOn": "NONE", "reviewOn": "NONE" }
    ]
  }
}
```

Each rule has a `glob` and an optional `blockOn` and/or `reviewOn` (the `blockAt` / `reviewAt`
aliases and the levels `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `NONE` work as for the global gate).

### Matching

A finding matches a rule when its file path matches the rule's glob. Globs behave like
`.secureflowignore` patterns (the same matcher is used, case-insensitive):

- a glob containing a `/`, such as `infra/**`, is anchored at the repository root;
- a glob without a `/`, such as `*.tf`, matches at any depth.

The finding's path is normalised first: backslashes become `/`, a trailing `:line` suffix and a
leading `./` or `/` are removed, so `./infra/main.tf` and `infra/main.tf:12` match like
`infra/main.tf`.

### Precedence

For `blockOn` and `reviewOn` separately: the first matching path rule (in file order) that sets
the key, then a matching type override, then the global value. A key a level leaves unset falls
through to the next level.

### Safe failure

A malformed rule (missing or non-string `glob`, unknown level) is skipped with a warning and the
other valid rules still apply. Invalid JSON, or a `paths` value that is not an array, never fails
a scan; the default gate (or the rest of the config) is used.

### Trust and scope

- Rules are read from the pull request's **base branch** only, as for the rest of the gate. A PR
  that edits `paths` on its own branch does not change its own verdict.
- Only the verdict changes. Findings under a relaxed path are still recorded and shown.
- When path rules are active, the check-run gate summary line says so
  (for example `Gate: block on CRITICAL+, review on MEDIUM+, 2 path rules active (from base branch)`),
  and a config with `paths` is never treated as the default gate.

## Monorepo Policy Scoping (`policyScopes`)

In monorepos, different directories and components typically require different policies:

- A `terraform/` or `infra/` folder needs infrastructure security and cloud compliance checks.
- A frontend `src/components/` folder needs Cross-Site Scripting (XSS) and client security policies.
- A `tests/` or `fixtures/` folder should not be flagged for test mock passwords or hardcoded test keys.

To prevent noise and accelerate scan times, add an optional `policyScopes` list to `.secureflow.json`:

```json
{
  "gate": {
    "blockOn": "HIGH",
    "reviewOn": "MEDIUM"
  },
  "policyScopes": [
    {
      "paths": ["terraform/**", "*.tf"],
      "enable": ["Infrastructure Security", "Hardcoded Secrets"]
    },
    {
      "paths": ["frontend/**"],
      "enable": ["Cross-Site Scripting (XSS)", "Content Security Policy"]
    },
    {
      "paths": ["tests/**", "**/*.test.*"],
      "disable": ["No Hardcoded Secrets"]
    }
  ]
}
```

### Options & Behavior

Each entry in `policyScopes` specifies:

- **`paths`**: Array of glob patterns matching changed files (e.g. `terraform/**`, `*.tf`). Globs follow the same syntax as `.secureflowignore`.
- **`enable`**: (Optional) Array of policy names (case-insensitive) to apply to matching files. When specified, only these policies run against the matching file.
- **`disable`**: (Optional) Array of policy names (case-insensitive) to exclude from matching files.

### Precedence and Conflicting Scopes

When a file matches multiple scopes, they are evaluated in definition order:

- An `enable` rule sets the allowed policies for the file.
- A subsequent `disable` rule removes specific policies from that set.
- A file that matches no scopes receives all active policies as usual.

### Safe Failure and Base Branch Guarantees

- **Base branch enforcement**: `.secureflow.json` is loaded exclusively from the base branch, preventing unauthorized changes in PR head branches.
- **Graceful degradation**: Invalid globs, non-string policy names, or unknown policy names are logged as warnings and ignored without failing or interrupting the scan.
- **PR comment reporting**: Applied policy scopes and the count of files scanned under each scope are shown in the PR comment summary under `📁 Policy Scopes Applied`.

## Default Ignore Patterns & Overrides (`includeDefaults`, `forceInclude`)

Generated and vendored files produce large diffs without useful LLM findings, waste AI tokens, trigger false positives, and slow down scans. SecureFlow applies a built-in default ignore list before scanning:

- **Common package manager lockfiles**: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `bun.lock`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`, `poetry.lock`, `Pipfile.lock`, `flake.lock`.
- **Minified bundles**: `*.min.js`, `*.min.css` (and `.min.mjs`, `.min.cjs`).
- **Source maps**: `*.map`.
- **Build and vendored directories**: `dist/`, `build/`, `vendor/`, `node_modules/`, `__snapshots__/`.
- **Generated Protobuf**: `*_pb2.py`, `*_pb2_grpc.py`, `*.pb.go`, `*.pb.cc`, `*.pb.h`, `*pb_test.go`, `proto/gen/`, `google/protobuf/`.
- **Generated OpenAPI client directories**: `client/openapi/`, `generated/openapi/`, `openapi/generated/`, `generated/`.

### Overriding and Disabling Defaults in `.secureflow.json`

Repositories can configure ignore defaults at the root level or in the `gate` / `ignore` block:

```json
{
  "includeDefaults": true,
  "forceInclude": ["vendor/critical-library/**", "client/openapi/custom-patch.ts"]
}
```

- **`includeDefaults`**: (Optional, boolean, default `true`). Set to `false` to completely disable built-in default ignore patterns.
- **`forceInclude`**: (Optional, string array). Array of glob patterns to force include in scanning, overriding default ignore rules.
- **`.secureflowignore` compatibility**: Explicit repository `.secureflowignore` rules continue working as before and take precedence.

### Deterministic Secret Pre-Scan & Safety Guarantees

- **Deterministic pre-scan runs on skipped files**: Fast regex and entropy-based secret detection continues to run on files excluded from LLM scanning (e.g. lockfiles and vendored bundles). If an active production secret is added, it is flagged.
- **Single changed file protection**: Files matching default ignore patterns are **never skipped** if they are the only files changed in the pull request and contain secret-like strings matching the deterministic secret pre-scan.
- **Transparent PR reporting**: The pull request summary comment displays how many files were skipped by defaults (e.g., `ℹ️ **3 files** skipped by default ignore patterns`), ensuring no changes are silently dropped.

## Scan Time Budget and Partial Results

A slow LLM response or a very large PR could otherwise keep a scan in progress indefinitely and return zero findings if it fails. SecureFlow supports a configurable scan time budget and per-request timeout:

```json
{
  "gate": {
    "timeoutBudget": 120,
    "requestTimeout": 60
  }
}
```

Or at the top-level of `.secureflow.json`:

```json
{
  "timeoutBudget": 120,
  "requestTimeout": 60
}
```

### Configuration Options

- **`timeoutBudget` / `timeoutBudgetSeconds`**: Total scan time budget in seconds (default: `120`). When this budget is reached, SecureFlow stops starting new chunks, preserves findings from completed chunks, and completes the check run as `neutral` with policy decision `PARTIAL`.
- **`requestTimeout` / `requestTimeoutSeconds`**: Per-request LLM timeout in seconds (default: `60`).

### Environment Variables

Defaults can also be configured across the deployment via environment variables:

- **`SCAN_TIMEOUT_BUDGET_SECONDS`**: Deployment-wide default scan time budget (seconds, default: `120`).
- **`SCAN_REQUEST_TIMEOUT_SECONDS`**: Deployment-wide default per-request LLM timeout (seconds, default: `60`).

### Partial Scan Behavior & Safety Guarantees

- **Preserves Completed Findings**: Findings from chunks that completed before the timeout are preserved and reported.
- **Visible Unscanned Files List**: The check run summary and details clearly list every unscanned file and the reason it was skipped (`scan timeout budget of ...s exceeded`).
- **Check Run Conclusion**: The GitHub check run concludes with `neutral` and title `Policy Decision: PARTIAL (<count> issues in <count> analyzed files)`.
- **Never Auto-Resolves Missing Findings**: Scans marked partial are flagged with `isPartialScan: true`. Automated finding resolution and scan comparison logic never treat missing findings as resolved or fixed during a partial scan.
- **Full Scans Unaffected**: When all files are scanned within the time budget, the scan behaves exactly as before.

## CLI Initialization and Validation (`secureflow --init` & `secureflow validate`)

To simplify repository setup and avoid manual syntax mistakes, use the SecureFlow CLI:

### 1. Generating Configuration (`secureflow --init`)

Run `secureflow --init` to interactively configure your repository:

```bash
# Interactive setup: guides you through hook mode, severity thresholds, ignores, and languages
npx secureflow --init

# Non-interactive / scripted setup with flags
npx secureflow --init --husky --severity HIGH --languages typescript,terraform --force
```

This creates both `.secureflow.json` and `.secureflowignore` with helpful comments and sensible defaults. Existing files will never be overwritten without explicit confirmation or the `--force` flag.

### 2. Validating Configuration (`secureflow validate`)

Run `secureflow validate` in CI or locally to verify your configuration files against the schema:

```bash
# Validates both .secureflow.json and .secureflowignore in the current repository
npx secureflow validate

# Validate a specific file
npx secureflow validate .secureflow.json
```

`secureflow validate` reports unknown keys, invalid severity levels, and malformed globs with exact file and line numbers, exiting non-zero when errors are detected.
