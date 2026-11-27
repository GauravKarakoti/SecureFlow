# Dependency Vulnerability Triage and Automated Maintenance

## Context & Purpose

As a security-scanning platform, SecureFlow must ensure its own dependency supply chain remains uncompromised and free of known vulnerabilities. Automated updates and continuous security audits significantly reduce the risk of shipping vulnerabilities into production or CLI artifacts.

This document describes the automated maintenance architecture and provides maintainers with actionable guidelines for triaging, evaluating, and remediating dependency vulnerabilities.

---

## Automated Pipeline Architecture

### 1. Dependabot Grouped Updates (`.github/dependabot.yml`)

Dependabot is configured to check weekly for updates across all package ecosystems in the repository:

- **Root web application (`/`)**: Node.js/Next.js dependencies grouped into single weekly update pull requests.
- **CLI package (`/packages/cli`)**: Command-line tool dependencies grouped into weekly update pull requests.
- **GitHub Actions (`/`)**: Workflow action versions grouped weekly to keep CI/CD pipelines pinned to supported action releases.

Grouped updates minimize pull request noise by combining routine dependency bumps into single reviewable PRs per package directory.

### 2. Scheduled Dependency Security Audit (`.github/workflows/dependency-audit.yml`)

- **Schedule**: Executes automatically every Monday at 04:00 UTC.
- **On Demand**: Supports manual execution at any time via the `workflow_dispatch` trigger in the GitHub Actions UI.
- **Failure Threshold**: Runs `npm audit --audit-level=high` across both the root package and the `/packages/cli` workspace. Any advisory classified as **High** or **Critical** fails the workflow immediately.
- **Visibility**: Build failures are prominently surfaced in the **Actions** tab of the GitHub repository.

---

## Maintainer Triage Guide

When a scheduled or on-demand **Dependency Security Audit** workflow fails in the Actions tab, maintainers should execute the following triage steps.

### Step 1: Inspect the Advisory

1. Open the failed run in **GitHub &rarr; Actions &rarr; Dependency Security Audit**.
2. Expand the failed step (`Run npm audit on root project` or `Run npm audit on CLI workspace`).
3. Note the following details for each flagged vulnerability:
   - **Package Name & Version**: The affected package.
   - **Severity**: `HIGH` or `CRITICAL`.
   - **Advisory Identifier**: CVE ID or GitHub Security Advisory (GHSA) ID.
   - **Dependency Chain**: Whether the package is a direct dependency or a nested (transitive) dependency.
   - **Affected File**: `package.json` (root) or `packages/cli/package.json`.

Alternatively, reproduce the audit output locally:

```bash
# Audit root dependencies
npm audit --audit-level=high

# Audit CLI workspace dependencies
npm audit --audit-level=high --workspace=packages/cli
```

### Step 2: Assess Reachability and Impact

Evaluate the actual exposure in SecureFlow:

| Dependency Type                     | Exposure Profile                                                                                               | Action Required                         |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------- | :-------------------------------------- |
| **Production (`dependencies`)**     | High urgency. Shipped to production web application or CLI runtime.                                            | Immediate triage and patching.          |
| **Development (`devDependencies`)** | Lower urgency unless the vulnerability affects build pipelines, code generation, or CI execution environments. | Patch via routine updates or overrides. |

Questions to answer:

- Does SecureFlow import the vulnerable package function or call the vulnerable method?
- Can an external attacker reach the vulnerable code path via untrusted user input (e.g. webhooks, PR code snippets, API requests)?

### Step 3: Select Remediation Strategy

Depending on the nature of the advisory and available upstream fixes, choose the appropriate remediation path:

#### Option A: Dependabot PR Available

If Dependabot has already submitted a weekly grouped PR addressing the vulnerability:

1. Review the Dependabot PR and verify CI checks pass.
2. Merge the PR into `main`.

#### Option B: Direct Dependency Upgrade

If a newer patched version of a direct dependency is released:

1. Update the version constraint in `package.json` or `packages/cli/package.json`:
   ```bash
   npm install <package>@latest
   ```
2. Re-run local checks:
   ```bash
   npm audit --audit-level=high
   npm test
   npm run typecheck
   npm run build
   ```

#### Option C: Transitive Dependency Override

If the advisory resides in a nested transitive dependency and the parent package has not yet bumped it:

1. Use npm's `overrides` field in the root `package.json` to force the patched version:
   ```json
   {
     "overrides": {
       "vulnerable-subpackage": "^1.2.3"
     }
   }
   ```
2. Run `npm install` to update `package-lock.json`.
3. Verify that the override resolves the advisory without breaking parent package functionality.

#### Option D: Breaking Change / Major Version Bump

If patching requires updating a dependency across a major breaking version:

1. Review the library's release notes and migration guide.
2. Update call sites in `src/` or `packages/cli/`.
3. Run the full test suite (`npm test`, `npm run test:e2e`, `npm run typecheck`).

#### Option E: No Upstream Patch Available

If no patched version has been released yet:

1. If the vulnerability is **unreachable** in SecureFlow (e.g. an unused submodule or dev-only tool):
   - Document the assessment in a tracking issue.
   - Monitor the upstream repository for fix availability.
2. If the vulnerability is **reachable**:
   - Introduce an input validation or sanitization guard to block the exploit vector.
   - If feasible, replace the dependency with an alternative secure library.

### Step 4: Verification & Resolution

1. Verify locally that the audit passes:
   ```bash
   npm audit --audit-level=high
   npm audit --audit-level=high --workspace=packages/cli
   ```
2. Commit the changes and open a pull request.
3. Once merged to `main`, navigate to **GitHub &rarr; Actions &rarr; Dependency Security Audit**.
4. Click **Run workflow** &rarr; select `main` &rarr; click **Run workflow** to verify the on-demand audit passes with a green checkmark.
