# Blocking merges on critical findings

SecureFlow reports every scan as a GitHub Check Run named **`SecureFlow Scan`**:

| Policy decision   | Check conclusion  |
| ----------------- | ----------------- |
| `PASS`            | `success`         |
| `REVIEW REQUIRED` | `action_required` |
| `BLOCKED`         | `failure`         |

If a scan fails permanently (after all retries), SecureFlow also posts a
`failure` check under the same name, so a PR is never left looking unscanned.
The check output is a fixed message; internal error details are not shown.

## Make the check enforceable

GitHub only blocks a merge when the check is **required**. In the repository:

1. Settings -> Branches -> Branch protection rules -> Add rule (or edit the rule for your default branch).
2. Enable **Require status checks to pass before merging**.
3. Search for and select **`SecureFlow Scan`**.
4. Save.

After this, a PR with a critical finding (`BLOCKED`) cannot be merged until the
finding is fixed or triaged as a false positive / ignored.

> The check name is fixed in `src/lib/scanner/check-run.ts` (`SCAN_CHECK_NAME`).
> Renaming it would silently stop enforcement for repositories that required the old name.
