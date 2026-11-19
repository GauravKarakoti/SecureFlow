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

## GitHub Merge Queue

If your repository uses GitHub Merge Queues:
1. Ensure the GitHub App is subscribed to the **`Merge group`** event (`merge_group`) with `Checks: Read & Write`, `Contents: Read`, and `Pull Requests: Read & Write` permissions.
2. In the branch protection rule or ruleset under **Require merge queue**, make **`SecureFlow Scan`** a required status check.
3. SecureFlow will automatically validate each temporary merge group ref (`checks_requested`), reusing previous PR scan results when diff content is unchanged or rescanning combined diffs, and report a completed check run on the merge group SHA so PRs merge smoothly.

> The check name is fixed in `src/lib/scanner/check-run.ts` (`SCAN_CHECK_NAME`).
> Renaming it would silently stop enforcement for repositories that required the old name.
