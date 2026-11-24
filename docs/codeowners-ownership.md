# CODEOWNERS in pull request reports

The sticky security report can show owners for active findings. The worker requests CODEOWNERS from the pull request's base repository and revision. It prefers the base commit SHA supplied by GitHub, with the base branch name as a fallback. It checks `.github/CODEOWNERS`, `CODEOWNERS`, then `docs/CODEOWNERS`, stopping at the first file found. A missing file, unreadable file, or lookup error leaves the original report intact.

The parser supports case-sensitive paths, `*` and `?` within a path segment, full-segment `**`, named directories, and leading-slash anchoring. The last matching rule wins. A matching ownerless rule shows **Unowned**. Names and email addresses are displayed as code so they do not generate mentions. Unsupported or malformed lines are skipped. The loader honors GitHub's 3 MB file limit. Ownership is display-only and the report does not verify users, team membership, or permissions.

**By owner** counts active findings. When a finding has more than one owner, each owner gets one count for that finding. Findings posted in an inline review appear by file in the sticky report because all findings in a file share its owners. If optional attribution would exceed GitHub's comment size limit, the report omits it.

## Run the fixture demo

From the repository root, run these commands after installing the locked dependencies:

```sh
GROQ_API_KEY=test-key npx vitest run src/lib/github/codeowners.test.ts src/lib/github/scan-report.test.ts
npx tsx scripts/demo-codeowners.ts
```

The demo prints an annotated report with multiple owners, an unowned finding, and one finding listed by its inline file. It then compares the output without a base CODEOWNERS file to the unchanged report and verifies that a file present only at the head revision has no effect. It uses fixture GitHub responses and needs no GitHub App credentials.

[GitHub CODEOWNERS syntax and file precedence](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
