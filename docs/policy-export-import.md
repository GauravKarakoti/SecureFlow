# Policy Export and Import Format Specification

SecureFlow supports exporting and importing custom security policies and guardrail toggles as portable, versioned JSON files. This enables backing up policy configurations, reviewing policy modifications in Git pull requests, and promoting tested policy sets across environments (e.g., from staging to production) without manual retyping.

---

## File Format & Specification

The policy exchange file is formatted in versioned JSON (Version `1.0`).

### Top-Level Schema

| Field        | Type   | Required | Description                                                    |
| ------------ | ------ | -------- | -------------------------------------------------------------- |
| `version`    | string | **Yes**  | Schema version. Currently strictly `"1.0"`.                    |
| `exportedAt` | string | No       | ISO 8601 timestamp representing when the file was exported.    |
| `policies`   | array  | **Yes**  | Array of policy definitions (maximum 100 policies per bundle). |

### Policy Object Schema

Each element in the `policies` array contains:

| Field            | Type           | Required | Constraints / Values                        | Description                                                                |
| ---------------- | -------------- | -------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `name`           | string         | **Yes**  | 1–128 characters                            | Unique title/name of the security policy.                                  |
| `description`    | string         | **Yes**  | 1–2048 characters                           | Human-readable explanation of what the policy enforces.                    |
| `severity`       | string         | **Yes**  | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO` | Finding severity attributed when the rule matches.                         |
| `enabled`        | boolean        | **Yes**  | `true` or `false`                           | Whether the policy is active/enforced for the user.                        |
| `action`         | string         | No       | Default: `"REVIEW REQUIRED"`                | Action triggered upon policy violation (`BLOCK`, `REVIEW REQUIRED`, etc.). |
| `rules`          | array / object | No       | Default: `[]`                               | Pattern conditions matching rule categories or file paths.                 |
| `complianceTags` | array          | No       | Default: `[]`                               | Mapped compliance frameworks (e.g. `["SOC 2", "OWASP Top 10"]`).           |

> [!NOTE]
> Internal identifiers (`id`, `userId`, `cuid`), creation timestamps, and user profile data are intentionally excluded to keep policy files completely portable across accounts and environments.

---

## Example `policies.json` File

```json
{
  "version": "1.0",
  "exportedAt": "2026-11-13T12:00:00.000Z",
  "policies": [
    {
      "name": "Enforce Parameterized Queries",
      "description": "Requires manual review for raw SQL queries to prevent SQL Injection vulnerabilities.",
      "severity": "HIGH",
      "enabled": true,
      "action": "REVIEW REQUIRED",
      "rules": ["db/raw_query/*"],
      "complianceTags": ["SOC 2", "OWASP Top 10"]
    },
    {
      "name": "Prevent PII Logging",
      "description": "Strictly blocks logging statements that output potentially sensitive Personal Identifiable Information (PII).",
      "severity": "CRITICAL",
      "enabled": true,
      "action": "DENY",
      "rules": ["logger/pii/*"],
      "complianceTags": ["GDPR", "HIPAA"]
    }
  ]
}
```

---

## Security & Validation Rules

1. **Strict Key Enforcement**: Extra or unknown top-level or item-level keys are strictly rejected with an error to prevent unrecognized parameters or malicious data injection.
2. **Safe Deserialization**: The file is parsed strictly as data. No code or script within the policy file is ever executed or evaluated.
3. **Payload Size Limits**: The import endpoint rejects files larger than 1 MB (413 Payload Too Large).
4. **Authentication & Rate Limiting**: Importing and exporting require an active authenticated user session and are protected against abuse via the standard rate limiter (`policies:import` and `policies:export`).
5. **Dry-Run Preview**: Uploading a policy file triggers a preview comparison against existing policy templates and current user toggles, displaying a breakdown of proposed creations, updates, and unchanged rules before any changes are written.
