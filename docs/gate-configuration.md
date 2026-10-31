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
