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

