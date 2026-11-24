# secureflow-cli

## 3.13.0

### Minor Changes

- b644f7d: feat(cli): add scan progress indicator, --quiet, and --verbose flags

  - Display real-time progress indicator on stderr during file scanning when attached to an interactive terminal, automatically disabled when output is piped or redirected.
  - Add `--quiet` (`-q`) flag to suppress progress, spinners, and informational logs, outputting only scan summaries and errors.
  - Add `--verbose` flag to display per-file execution timing and skipped file details.
  - Disallow combining `--quiet` and `--verbose` with a clear usage error.

- c56d35f: feat(scanner): second verification pass for CRITICAL findings before a PR is blocked (#2007)
- 8bc8978: Attach standard CWE identifiers (e.g. CWE-798, CWE-89) to findings, include them as SARIF rule tags, add them to compliance exports, and display them as clickable MITRE badges in the findings dashboard (#2008).
- 88dc2c2: feat(rules): flag risky newly added dependencies in package manifests (typosquatting, install scripts) (#2003)
- 5ff41e5: feat(scanner): configurable surrounding context lines for diff hunks (#2006)
- de154ce: feat(rules): deterministic infrastructure-as-code checks for Dockerfile, Kubernetes and Terraform changes (#2004)
- d8aa1d8: feat(config): installation-level default settings that repositories inherit and can override (#2010)
- e23fe41: feat(notifications): in-app notification center with @mentions in finding notes and assignment alerts (#1979)
- bf3e17d: feat(queue): per-installation concurrency limits and round-robin fair scheduling (#1980)
- d92cb5d: feat(github): add hidden HTML marker, commit SHA, and scan time to sticky PR comments
- 678e959: feat(scanner): configurable scan time budget and partial results (#1981)
- 9775e5e: feat(scanner): built-in default ignore patterns for lockfiles, minified bundles, vendored code and snapshots (#1983)
- 54f33ac: Add nightly scanner LLM stability evaluation check that re-scans golden fixtures across iterations, reports per-sample stability percentages, highlights runs below threshold, and publishes results to GitHub Actions job summaries (#2009).
- cd99460: feat(scans): scheduled baseline scan of the default branch (#2011)

  - Added opt-in scheduled baseline scanning for default branches in repositories.
  - Implemented baseline file limit bounds (1-200, default 50) and frequency scheduling (daily, weekly, monthly).
  - Distributed baseline scan jobs using fair queue scheduling across installations with concurrency limits.
  - Tagged baseline findings with `BASELINE` and stored them under dedicated baseline container (`prNumber: 0`), preventing them from blocking PR checks.
  - Added Baseline Findings dashboard tab and filterable queries in findings management.
  - Added scheduled baseline settings section and manual "Run Baseline Scan Now" action in settings dashboard.

- dd4da91: feat(config): skip draft pull requests and selected authors (bots) through .secureflow.json (#1982)
- ac0100a: feat(pr): post remediation as GitHub suggested-change blocks when the fix is a small safe edit (#2005)
- f4a6d7f: feat(ai): verify generated patches apply cleanly before showing them (#1977)
- f31e556: feat(rules): deterministic security checks for changed GitHub Actions workflows (#2002)

### Patch Changes

- 9c86afd: feat(pr): minimize outdated comments and delete-old-and-create sticky report on pushes (#2012)

  - Added `replaceSecureFlowComment` and `deleteCommentSafely` to delete old SecureFlow comments before posting a clean new report comment.
  - Added `minimizeOutdatedComment` using GitHub GraphQL `minimizeComment` mutation to mark stale comments as OUTDATED.
  - Added `findAllSecureFlowComments` to reliably discover all historical comments across pagination.
  - Added support for `replaceOldComments` option in `upsertSecureFlowComment`.
  - Handled graceful fallback when old comments were deleted or when deletion API permissions are restricted.

- e20ffff: verify(docker): [NSoC_2026] verify Dockerfile and heist prompt-guard suites without regression (#1794)

## 3.12.0

### Minor Changes

- 0fba786: Show CODEOWNERS attribution for active pull request findings using the base revision.
- 493232f: ci(release): sign container images with cosign and attach SBOM and provenance attestations (#1926)
- e52c1f7: feat(findings): create a GitHub issue from a finding with a redacted, pre-filled description (#1987)
- ce86d37: feat(triage): assign findings to a team member and add an 'Assigned to me' filter (#1921)
- 6dceb03: feat(triage): add reviewer notes (comment thread) to a finding (#1920)
- 6d57ec2: feat(triage): [NSoC_2026] finding triage dismissal, stable fingerprinting, and scan-time suppression (#1702)

  - Validate triage dismissal action with required category (`FALSE_POSITIVE`, `ACCEPTED_RISK`, `WONT_FIX`) and min 5 characters reason.
  - Enforce deterministic content fingerprinting ignoring line numbers to maintain suppression across line shifts.
  - Suppress dismissed findings in scan pipeline, preventing PR check blocks and excluding them from risk scores.
  - Display suppressed findings count in PR comment report.
  - Include end-to-end integration test coverage for all #1702 acceptance criteria.

- 62aaa6d: feat(scanner): handle zero analyzed files in PR scan with neutral check run and descriptive message
- 0180f10: feat(auth): add read-only Viewer and Triager roles for installation members (#1922)
- 6b077c4: feat(scans): compare two scans of the same pull request to show what is new, fixed or unchanged (#1923)
- c647920: feat(scanner): per-finding confidence score and configurable threshold for PR comment (#1924)
- ae063ad: feat(scanner): detect the language and framework of each changed file and pass it as scan context (#1925)
- fa10c3d: feat(config): [NSoC_2026] add schema.json for .secureflow.json validation (#1917)
- e850dc3: feat(webhook): add a webhook delivery diagnostics page showing recent events and why they were ignored (#1928)

### Patch Changes

- 5c2896a: Add devcontainer and Codespaces configuration with Docker Compose for one-click contributor setup (#1985).
- 94c2041: Add Helm values.schema.json validation and negative CI tests to reject invalid chart configurations (#1984).
- 2a63bea: Separate expired suppression rules from active rules in the admin console and require explicit renewal with a future expiry before editing them.
- 7f034f5: test(helm): add helm-unittest and chart-testing checks for the Helm chart in CI (#1927)

## 3.11.0

### Minor Changes

- fd11fd4: feat(cli): add LRU eviction, TTL expiry, max storage limits, and cache-prune/cache-stats commands to scan cache (#1934)
- 94726bd: feat(cli): add recursive directory scanning with workspace path sandboxing and non-git fallback (#1933)
- 491ecb1: feat(cli): add --fail-on severity thresholds, exit codes (0, 1, 2), and one-line severity count summary
- 1e57feb: feat(ui): make the dashboard tables usable on phones (card layout, sticky headers, horizontal scroll hints) (#1929)
- c9fb1c1: feat(policies): backtest a changed policy against recent scans to preview its impact (#1892)
- c8a0be0: Add Export CSV and Export JSON buttons to findings dashboard with active filters, sorting, and full streaming support
- a7ae4d0: feat(cli): support gitignore-style .secureflowignore with default ignores, negation, and verbose skipped file counts (#1827)

### Patch Changes

- d03d4bb: fix(armor): isolate deterministic secret fingerprints by repository and normalize whitespace line-drift (#1935)

## 3.10.0

### Minor Changes

- 4e87c9e: Add content hash and ruleset version caching to SecureFlow CLI. Results are stored in `<repoRoot>/.secureflow/cache` keyed by file SHA-256 and ruleset version, skipping unchanged files on repeat scans. Supports `--no-cache` to bypass caching, `secureflow cache-clear` to wipe stored entries, and safely ignores or cleans corrupted cache entries.
- 03e2599: feat(cli): integrate repository configuration generator and schema validator into secureflow CLI (#1898)

  - Enhanced `secureflow --init` to generate `.secureflow.json` and `.secureflowignore` with helpful comments and sensible defaults alongside git hook initialization.
  - Added interactive and non-interactive setup with language auto-detection and flags (`--severity`, `--ignore`, `--languages`, `--force`).
  - Enforced overwrite safety: existing configuration files are never overwritten without explicit user confirmation or `--force`.
  - Added `secureflow validate` / `secureflow-cli validate` to validate `.secureflow.json` and `.secureflowignore` against shared schemas.
  - Line-number error reporting: unknown keys, invalid severities, and invalid globs are reported with exact file, line, and column numbers, exiting non-zero on failure.
  - Shared schema and comment-stripping parser between server (`gate-config.ts`) and CLI via `secureflow-cli/contracts`.

- 66885ca: feat(triage): bulk dismiss several findings at once with one shared reason (#1889)
- fe24fd5: feat(observability): add OpenTelemetry distributed tracing across webhook, queue, scan, AI, and GitHub API (#1897)
- 90b8615: feat(config): support *_FILE variants for secrets in Docker and Kubernetes (#1893)
- 0e48258: feat(triage): installation-wide suppression rules for a finding type or file pattern (#1891)
- 81616d8: feat(triage): optional expiry date for dismissed findings with auto-reopen, audit logging, and dashboard filter (#1890)
- 0145d26: feat(api): add GET /api/version endpoint, dashboard footer version, and safe upgrade guide (#1896)
- c097ad9: feat(security): [NSoC_2026] add operator clearance, Groq action sanitization, CLI patch rate-limiting, and optimized incident logging (#1819)
- f25ff25: ops(db): add db:backup, db:restore and db:verify-backup CLI tools with safe restore guards and scheduled automation guides (#1895)

### Patch Changes

- cbf6e5e: fix(worker): graceful shutdown on SIGTERM/SIGINT with in-flight scan recovery and Helm termination grace period (#1894)

## 3.9.0

### Minor Changes

- 42e5e04: Add cursor pagination and broken-link pinpointing to /api/admin/audit/verify (#1796).
- f98cfbd: Add stale-while-revalidate fallback and threatIntelSource telemetry to threat intelligence cache during MCP scans (#1795).
- 43a42ef: feat(dashboard): per-repository security health overview with trend (#1870)
- 933cf49: feat(helm): [NSoC_2026] add local AI inference VRAM resource limits and queue HPA triggers to worker chart (#1797)
- 3c46ebf: Add automated bundle size budgets, @next/bundle-analyzer, and Lighthouse CI quality gates (#1872).

  - Added `@next/bundle-analyzer` integration opt-in via `ANALYZE=true` and `npm run analyze`.
  - Configured per-route JavaScript bundle size budgets and growth thresholds in `bundle-budget.json`.
  - Added `scripts/check-bundle-budgets.ts` to inspect Next.js build manifests and enforce budget thresholds in CI.
  - Configured Lighthouse CI audits on authentication and dashboard pages in `lighthouse-budget.json` and `.lighthouserc.json`.
  - Added `scripts/lighthouse-summary.ts` to output formatted audit results into GitHub Actions job summaries (`$GITHUB_STEP_SUMMARY`).
  - Added budget adjustment policies and justification documentation in `CONTRIBUTING.md`.

### Patch Changes

- 0badba3: Add Playwright visual regression snapshot testing for key dashboard pages (#1871).

  - Added `toHaveScreenshot` snapshot test suite (`e2e/visual-regression.spec.ts`) for key dashboard pages with masked dynamic content, frozen clock, and disabled animations.
  - Stored baseline snapshots in `e2e/__screenshots__/`.
  - Added dedicated `test:visual` and `test:visual:update` scripts.
  - Added opt-in CI workflow (`.github/workflows/visual-regression.yml`) with automated diff artifact uploading on failure.
  - Documented baseline review and update procedures in `CONTRIBUTING.md`.

## 3.8.0

### Minor Changes

- 0dbbe86: Improve accessibility (a11y) across severity badges, tables, and charts to comply with WCAG AA. Ensure interactive elements are keyboard reachable with visible focus rings, add ARIA labels to icon buttons, severity badges, and charts, enforce non-color indicators (icons and text) alongside severity colors, fix light-mode and dark-mode text contrast ratios, and provide automated axe-core audits.
- 79a54a1: Automatically mark findings as resolved when a later push removes them (#1869). After each completed full scan of a pull request, compares new finding fingerprints with open findings from earlier scans of the same pull request. Findings whose fingerprint is no longer detected are marked as `RESOLVED`, recording the resolving commit SHA, timestamp, and audit trail. Dismissed findings maintain their dismissed status, and failed or partial scans never resolve findings. The dashboard displays "resolved by commit <sha>" on finding badges and cards, and average resolution time is computed and surfaced in the analytics dashboard.
- 596ee63: Handle GitHub `check_run` and `check_suite` rerequested events to trigger manual scan re-runs (#1863). Clicking "Re-run" on a SecureFlow check run or check suite starts a new scan that updates the existing check run and pull request comment. Foreign check runs from third-party apps are safely ignored. Re-requests share the same signature verification, HMAC checking, delivery deduplication, and per-PR distributed locking as the synchronize path, preventing duplicate concurrent scans under rapid clicks. Audit logs record manual re-run triggers.
- 61be29a: Publish scan findings to GitHub Code Scanning via SARIF upload API (#1865). Adds a per-repository opt-in setting ("Publish findings to GitHub Code Scanning") in Settings (`/dashboard/settings`). Following a scan, findings are exported as SARIF v2.1.0 and uploaded to GitHub's code scanning API for the commit SHA and ref with stable tool name, rule IDs, and fingerprints to prevent duplicate alerts. Secret values and tokens are strictly sanitized using `maskFindingText` before upload. Missing permissions (`security_events: write`) or disabled Advanced Security are surfaced as actionable warnings on the repository card without failing the scan check run.
- 4018984: Track finding age and show overdue indicators by severity. Compute finding age from creation date, display age and overdue badges on the Findings dashboard, show overdue finding count on the Analytics page, and support configurable target thresholds via environment variables with validation.
- 9ff261b: docs(observability): ship a ready-made Grafana dashboard and optional Helm ConfigMap for existing metrics (#1784)
- cc3be99: feat(mcp): [NSoC_2026] gracefully handle client disconnections and add liveness checks (#1769)
- 0f4671f: Support GitHub Merge Queue by handling the `merge_group` webhook event (`checks_requested`). Automatically reports the required check run `SecureFlow Scan` on the merge group head SHA, reusing previous PR scan results when diff content is unchanged or executing a fast scan of the combined diff against the base-branch policy gate.
- bcb3ce7: Support signed outbound webhooks for scan and finding events (#1866). Allows users to register one or more HTTPS endpoints with selected events (`scan.completed`, `scan.blocked`, `finding.created`, `finding.dismissed`). Requests are signed with an `X-SecureFlow-Signature` HMAC-SHA256 header using a per-endpoint secret shown once at registration, and include event ID and timestamp for replay protection. Delivery is asynchronous with short timeout, retries with exponential backoff, and a delivery log visible in Settings. Enforces strict SSRF protection by blocking private, loopback, and link-local addresses upon saving and dispatch, with zero code snippets or secrets included in payloads.
- d3e0733: Add Personal API Tokens with granular scopes, expiry, and last-used tracking (#1867). Users can generate named Bearer tokens (`sft_...`) with customizable expiry (30, 90 days, or custom date) and granular permissions (`findings:read`, `findings:write`, `scans:read`, `scans:write`, `policies:read`, `policies:write`, `audit:read`). Tokens are displayed once at creation and stored exclusively as SHA-256 hashes in PostgreSQL. API routes enforce required scopes (returning 403 on insufficient permissions) and validate token status (returning 401 on expired or revoked tokens). Successful requests record `lastUsedAt` and `lastUsedIp`, rate limiting is enforced per token, and token creation/revocation lifecycle events are captured in the tamper-evident audit log.
- 00fde54: Scope policies to paths in `.secureflow.json` for monorepos (#1868). Extends `.secureflow.json` with an optional `policyScopes` list where each entry specifies file path globs and either `enable` or `disable` lists of policy names. Files matching a scope only receive the policies allowed for that scope before the diff is sent to the scanner. Scopes are read exclusively from the base branch, invalid globs and unknown policies produce warnings without crashing scans, and applied scopes are reported in pull request comments.
- b21ab06: feat(reports): generate weekly security digest summarizing findings and trends via Brevo mailing service (#1788)

### Patch Changes

- ed5f408: Add comprehensive contributor guide in CONTRIBUTING.md and link from README.md. Documents system prerequisites, 2-minute quickstart to set up and run tests with zero external credentials, instructions for building and running the CLI and Mission Control dashboard (mock mode, Docker Compose, local Postgres), explanations and concrete examples for `level1`, `level2`, and `level3` difficulty labels, branch naming conventions, Conventional Commits, and PR checklist guidance.

## 3.7.0

### Minor Changes

- f9cc22a: Follow NO_COLOR specification and automatically detect non-interactive terminals to disable ANSI color formatting, with `--color` to force color on and `--no-color` to explicitly disable it.
- 891037b: Add `--since REF` option to scan only files changed versus a git reference (e.g. `--since origin/main`). Includes added, copied, modified, and renamed files while skipping deleted files, and fails with clear user guidance when outside a git repository or when the specified git ref does not exist.
- 9fca054: Add environment variables (`AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`) for remediation and explanation models with startup validation and verbose active model logging.
- 7fcdfb7: Add side-by-side vulnerable code and remediation review view per finding with highlighted affected lines, line number gutter, secret masking, one-click copy buttons for code and suggested fix, direct shareable URL route with copy link button, graceful empty state handling for missing code context, a dedicated not-found page for missing findings, and navigation links from the findings table rows.
- ec2109f: Refresh the latest scanned PR verdict and existing SecureFlow check after a repository owner suppresses or reopens a finding. Store scan context in Prisma migration `20261117084000_finding_triage_scan_context`, allow optional notes with a required dismissal category, and preserve suppression across rescans.
- cf20549: Support GitHub Enterprise Server through configurable API and web base URLs (#1809). Adds `GITHUB_API_URL` (defaulting to `https://api.github.com`) and `GITHUB_WEB_URL` (defaulting to `https://github.com` or custom instance origin), validates them with the typed environment schema, routes all Octokit and GitHub App client calls through the configured API base URL, ensures comments, notifications, and dashboard links use the configured web URL, rejects non-HTTPS URLs in production mode, and documents setup in `docs/setup.md`.
- f7504d0: Support reasons and expiry dates for `.secureflowignore` entries (#1811). Allows ignore patterns to specify an optional `reason` and optional `expires` date (via bracket syntax `[expires=YYYY-MM-DD]: <reason>`, comment syntax, colon separator, or JSON entries) while maintaining backward compatibility with plain patterns. Expired entries are no longer applied and are reported in the pull request comment so they can be reviewed. Entries without reasons emit a scan log warning, and invalid dates are reported safely without crashing the scan.
- 7e45a3d: Add saved filter views and shareable URL query state for the Findings table. Active filters (severity, status, repository, type, search, sort, date range) sync to URL parameters, query parameters are validated on the server with fallback to defaults, and users can save, apply, and delete private named filter views.
- 11cd06b: Add golden-file regression test suite for scanner prompts (#1807). Adds 12 code samples (positives and negatives covering hardcoded secrets, SQL injection, wildcard CORS, root containers, command injection, path traversal, and safe code) with recorded Groq LLM fixtures, CI unit tests running without network or real API keys, an opt-in live prompt regression runner (`npm run test:prompts:live`) with readable diff reporting and `--update` support, and updated documentation in CONTRIBUTING.md.
- a56ff09: Add Light, Dark, and System theme options in the application header with persistent user preference in localStorage. Default to system preference, avoid flash of wrong theme on first paint via inline blocking script, ensure high contrast across severity badges and UI cards in both themes, and handle dynamic system color-scheme changes.
- 7068da5: Add k6 load test suite for webhook endpoint with documented thresholds (#1810). Adds `load-tests/webhook.k6.js` and `load-tests/helpers/signature.js` to simulate ramping GitHub pull request webhook traffic with authentic HMAC-SHA256 signatures and synthetic repository data, defines p95 response time (< 500ms) and failure rate (< 1%) thresholds, adds an opt-in manual GitHub Actions workflow (`.github/workflows/webhook-load-test.yml`), and documents local Docker Compose execution and metric interpretation in `docs/load-testing.md`.

### Patch Changes

- dd6e654: Add comprehensive architecture documentation and Mermaid diagrams in docs/architecture.md (#1808). Includes end-to-end webhook-to-check-run sequence diagram, system component topology, failure routing (DLQ, circuit breaker), simplified PostgreSQL data model, and links from README.md and CONTRIBUTING.md.
- a792a38: Add snapshot test suite and deterministic fixtures for CLI output formatting to catch accidental layout, border, badge, and summary regressions with color disabled.
- 00aae29: Add Dependabot configuration for npm package folders and GitHub Actions with weekly grouped updates, add a scheduled and on-demand workflow running npm audit that fails on high or critical advisories, and document maintainer triage procedures.
- 5695aa6: feat(reports): [NSoC_2026] add themed heist metrics and one-click shareable report export (#1711)
- 4b196df: Sync severity, status, search text, and sort order with URL query parameters on the findings table. Restore active filters on page load, fallback invalid query parameters to defaults without crashing, enable browser back/forward history navigation, and add a Clear filters button.

## 3.6.0

### Minor Changes

- b2b554b: feat(cli): [NSoC_2026] allow choosing between Blank and Husky in secureflow --init (#1758)
- 79de755: feat(onboarding): add first-run checklist that confirms installation, policies and a test scan (#1787)
- 232d606: ci(db): fail build on schema-migration drift, add `npm run db:check-drift` script, and document in CONTRIBUTING.md (#1691)

### Patch Changes

- 6ca8597: fix(ai): wire request abort signals into local model generation and enforce semaphore-based VRAM concurrency queue (#1753)
- c08b715: fix: serve a neutral SVG when the public badge database lookup fails, and copy absolute badge URLs from the current app origin (#1791)
- 52170d5: feat(helm): [NSoC_2026] tighten worker pod egress rules and document required endpoints in deployment guide (#1767)

## 3.5.0

### Minor Changes

- 3d7ea4a: Implement circuit breaker protection and static fallback management for AI inference calls across remediation patch, security explanation, and Web3 explanation flows (#1768).
- 75c0e19: Implement automated DLQ replay mechanism and telemetry for ArmorIQ events (#1765)
- 282c068: Add native SARIF export format support in secureflow-cli (#1766)

## 3.4.0

### Minor Changes

- 83cbc3a: Enforce workspace path sandboxing and incremental diff scanning in MCP server (#1752)
- 8f8010c: Include cryptographic fingerprints and remediation patch hunks in SARIF exports (#1754)
- d121fa2: add stale-while-revalidate fallback and checksum verification to threat intel cache (#1750)

### Patch Changes

- e8f13a7: fix(armoriq): [NSoC_2026] queue unverified intents to DLQ on circuit breaker trip (#1751)
- 56d1a06: feat(testing): [NSoC_2026] display failed test file names at end of test run (#1719)
- 01f98ac: Restrict worker egress when chart NetworkPolicy is enabled: require explicit public IPv4 destination CIDRs, preserve DNS and same-release database connections, exclude private and metadata addresses, and test worker PDB selectors. No database migrations or AI flow changes.

  Restore CI validation with a non-production Helm secret fixture, readonly Vitest reporter inputs, and Prisma 7 drift options using a separate ephemeral shadow database.

## 3.3.0

### Minor Changes

- 6486f3b: feat(cli): [NSoC_2026] upgrade secureflow --init to run npm init and husky init before hook setup (#1731)

## 3.2.0

### Minor Changes

- 7a77aea: feat(cli): [NSoC_2026] design beautiful terminal greeting for secureflow --init (#1732)

## 3.1.0

### Minor Changes

- 3be7865: integrate ArmorIQ intent verification hooks and granular policy guardrails in CI (#1710)
- 5656a5f: add interactive TUI warning tables, progress spinners, and --init husky ergonomics (#1712)
- 69d2f56: add end-to-end Playwright testing and AI evaluation pipeline (#1714)

## 2.13.0

### Minor Changes

- 774bb2a: expose Web3 explanations and AI remediation patch tools in CLI MCP server (#1698)
- d1135f1: Add offline local-model and silent audio fallback for audio-debrief and explain-stream when cloud APIs or circuit breakers trip (#1701).
- d67ead6: Back circuit breaker state store with Redis across multi-replica Kubernetes pods with graceful in-memory fallback (#1699).

## 2.12.0

### Minor Changes

- 11fe32b: Support expiring inline suppression directives (`// secureflow-ignore[expires=YYYY-MM-DD]: reason`) with clock injection, boundary validation, and PR report updates.
- c5cf964: Expand MCP server with threat intelligence lookup, OASIS SARIF v2.1.0 export, and AI remediation patch generation tools (#1682).

## 2.11.0

### Minor Changes

- 6d63a45: Add fallback and VRAM pressure test suites for streaming AI flows (heist-message-stream and security-explanation-stream).

## 2.10.0

### Minor Changes

- 4951070: Add comprehensive rendering, skeleton layout, and aria-busy accessibility unit tests for Admin Portal loading states across admin, logs, queue, and users.
- 783e8da: Add SBOM scanning (`secureflow sbom <file>`) and Web3 smart contract explanation (`secureflow explain --web3`) subcommands with background job status polling and local resilience fallbacks.
- 79b099d: Implement deterministic secret pre-scanner (`src/lib/armor/precheck.ts`) running prior to LLM analysis for fast, offline-resilient credential detection and redaction.

## 2.9.0

### Minor Changes

- b784e7c: Add loading.tsx suspense skeleton and server component test suite page.test.tsx for dashboard/policies route.

## 2.8.1

### Patch Changes

- adeef61: Added dedicated resilience, circuit-breaker, and provider outage test suites for `/api/findings/[id]/explain-stream`, `/api/findings/[id]/audio-debrief`, `/api/voice-alerts/stream`, and `/api/heist-transmission` (#1553).
- 7a4ee45: Added comprehensive Playwright E2E test suite in `e2e/cli-scan-triage.spec.ts` covering CLI scan uploads (`/api/cli/scan`), findings validation, and dashboard finding triage dismissal persistence on reload (#1555).
- 6fff754: Reject conflicting Helm secret providers in schema validation and template rendering, including existing Secret references combined with controller-managed secrets.

## 2.8.0

### Minor Changes

- 3ec7145: Finding Triage & Dismissal (#1528):

  - Added `DISMISSED` triage status with dismissal reason categories (`FALSE_POSITIVE`, `ACCEPTED_RISK`, `WONT_FIX`).
  - Enforced required reason notes on dismissal actions.
  - Supported stable fingerprint-based scan-time suppression so dismissed findings do not block pull requests or Check Runs.
  - Added previously dismissed findings reporting in pull request comment summaries.
  - Recorded full audit trail in Vault Logs with actor, finding, dismissal reason, note, and timestamp.
  - Added dashboard triage controls for dismissing and reopening findings.

- 0006f70: Expose read-only MCP source scanning with bounded entropy sensitivity and redacted SARIF, JSON, text, CSV, HTML and Markdown exports.

## 2.7.0

### Minor Changes

- 2ee9608: feat(admin): add granular route-level error boundaries for /admin/logs, /admin/queue, and /admin/users (#1527)
- 948311f: Refine secret detection regex patterns and add entropy filtering to suppress benign placeholder tokens (#1512)
- 9788696: Add Playwright E2E test suites for GitHub webhooks, generic inbound webhooks, and compliance exports (#1524)

## 2.6.0

### Minor Changes

- 2a1f329: Add ArmorIQ circuit breaker protection and comprehensive resilience test suite for bulk remediation (#1488).
- d01dd1c: Add loading.tsx and page.test.tsx server component tests to dashboard/ai-health (#1498).
- f82dd2a: feat(api): add base REST handler for single finding at /api/findings/[id] (#1465)

  - Implement GET (fetch full finding detail with ownership check), PATCH (update triage status/severity), and DELETE (permanent removal with audit log)
  - All operations scope to the authenticated session user via the relation chain to prevent IDOR attacks
  - Dual-tier rate limiting: IP-based outer guard + per-user inner guard
  - New route test file with 17 test cases covering auth, ownership, validation, rate limiting, and success paths
  - Updated `docs/api.md` and `openapi.yaml` with full endpoint documentation

- d6117d6: feat(policy): configurable pull-request gate per repository via .secureflow.json (#1491, #1470)
- 89728c0: Add a bounded, validated get_remediation_context MCP tool for caller-provided history, with explicit application-rate denominators and no inferred production statistics. Document the stdio JSON-RPC tools and test calls through the real SDK transport.
- e45d814: Add optional expiry to finding dismissals with active suppression filtering and UI controls (#1503).
- 07eb7d2: feat(tts-cache): add database-backed persistence layer and rate limiting for ElevenLabs audio debriefs (#1377)

  - Add `AudioDebriefCache` Prisma model for durable audio storage mapped to finding content hashes
  - Implement `src/lib/findings/audio-debrief-db.ts` with multi-tier cache (in-memory -> Redis -> database)
  - Upgrade `getCachedAudioDebrief` and `setCachedAudioDebrief` to support persistent DB cache fallback
  - Add per-user rate limiting on `/api/voice-alerts/stream` to prevent reconnect quota exhaustion
  - Add comprehensive test coverage in `src/app/api/findings/[id]/audio-debrief/route.test.ts` and `src/app/api/voice-alerts/stream/route.test.ts`

- 4789a88: Add comprehensive unit test suites for db-client.ts, instrumentation.ts, and prompt-injection-payloads.ts (#1500).
- 9665a2e: feat(webhooks): add GitLab and Bitbucket webhook ingestion handlers (#1466)

  - Implement `src/app/api/webhooks/gitlab/route.ts` with X-Gitlab-Token timing-safe validation
  - Implement `src/app/api/webhooks/bitbucket/route.ts` with HMAC-SHA256 X-Hub-Signature verification
  - Add `src/lib/webhooks/gitlab-verification.ts` with verification helpers (timing-safe token comparison, event type guards, safe log labels)
  - Add `src/lib/webhooks/bitbucket-verification.ts` with HMAC helpers, signature parsing, and event routing
  - Add unit tests for both verification libraries (47 tests across 2 files)
  - Add integration route tests for both routes (19 tests across 2 files)
  - Updated `docs/api.md` and `openapi.yaml` with full endpoint documentation
  - New env vars: `GITLAB_WEBHOOK_TOKEN`, `BITBUCKET_WEBHOOK_SECRET`

### Patch Changes

- 32cb882: test(dashboard): add server page unit tests for Analytics and Audit routes (#1469)

  - Add `src/app/dashboard/analytics/page.test.tsx` testing server-side session authentication guards, query param range parsing (7, 30, 90 days), data aggregation prop forwarding to `AnalyticsClient`, and empty state handling
  - Add `src/app/dashboard/audit/page.test.tsx` testing session auth redirection, Prisma parallel counts for monitored repositories and recent system actions, user display name fallbacks, and prop passing to `AuditLogTable`

- 20fa9c8: Add scan/date and scan/severity/date Finding indexes for analytics windows and severity-bucket reads in migration 20261103070000_finding_analytics_indexes. Replace the redundant scan/severity index while preserving its equality prefix.
- 6cc851e: Add route-level `loading.tsx` and `error.tsx` boundaries to the finding detail and AI remediation pages.

## 2.5.0

### Minor Changes

- 52bd6fd: **Breaking for some senders.** `POST /api/webhooks` and `POST /api/webhooks/generic` no longer admit a legacy `sha256=` signature computed over the bare body. That digest covers no timestamp, so a captured request could be replayed at any later time by setting `X-SecureFlow-Timestamp` to the current time, and any timestamp-bound digest doubled as a bare digest of the body `<t>.<body>`. v1 signatures (`t=<unix>,v1=<hex>`) and legacy digests over `<unix>.<body>` (what `signOutboundWebhook` sends) are unaffected. Senders that cannot switch yet can be re-admitted with `WEBHOOK_ALLOW_UNBOUND_LEGACY_SIGNATURES=true`; `withWebhookGuard`, `verifyWebhookRequest` and `admitWebhookRequest` take an `allowUnboundLegacySignatures` option for the same purpose.

### Patch Changes

- fb937c4: Calls to the ArmorIQ control plane (`ArmorIQService.verifyIntentToken`, `ArmorIQService.getProtectedToken` and the intent token mint in `POST /api/findings/[id]/remediate/apply`) now go through a shared circuit breaker. After 3 consecutive upstream failures (timeouts, rate limits, 5xx or network errors) the circuit opens and callers fail fast and closed instead of each waiting out its own timeout: verification returns `{ valid: false, unavailable: true }` and the remediation apply route answers `503` without writing to GitHub. A probe is let through after 30 seconds. A token that ArmorIQ answers and rejects does not count as an outage. Tune with the new optional `ARMORIQ_CIRCUIT_FAILURE_THRESHOLD` and `ARMORIQ_CIRCUIT_RESET_TIMEOUT_MS`.
- e9e1836: The job-queue Redis client no longer falls back to `redis://localhost:6379` in production. With `REDIS_URL` unset it now throws a clear configuration error at startup instead of hanging every enqueue; development, tests and `next build` keep the local default. `REDIS_URL` must be a `redis://` or `rediss://` URL. The Upstash rate limiter now requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` together, and the URL must be https. docker-compose now runs a Redis service and sets `REDIS_URL` unless `.env` provides one. Error messages name variables, never values.
- 461c23e: Outbound webhooks (the outbound worker and Slack alerts) now connect only to the addresses that passed the destination checks. Dispatch previously validated the DNS answer and then let `fetch` resolve the hostname again, so a DNS server answering with a zero TTL could steer the connection to an internal address such as `169.254.169.254`. Requests are now sent by `pinnedTransport` (`src/lib/queue/outbound-dispatch.ts`), which keeps TLS certificate verification, SNI and the `Host` header bound to the hostname. The IPv6 classifier now also refuses NAT64, 6to4, SIIT and Teredo addresses that wrap a private IPv4 address, plus documentation and site-local ranges.
- b892094: The session returned by `/api/auth/session` and embedded in pages for `SessionProvider` no longer carries the user's GitHub OAuth access token. Server code that needs the token (repository sync on the dashboard, the sync server action and `POST /api/repositories/sync`) now reads it with `getSessionWithGitHubToken()` from `@/lib/github/user-access-token`, which takes it from the session callback within the same `auth()` call. The refresh token was never in the session and remains only in the encrypted JWT.
- 18bdcf1: Importing the scan engine (`src/lib/scanner/scanEngine.ts`) no longer starts the `github-webhooks` BullMQ consumer. The engine took `getGitHubAppCredentials` from `@/lib/queue/worker`, which constructs that Worker at module scope, so any process that loaded the engine — including one meant to run only the scan pool — also consumed webhook jobs. It now imports the helper from `@/lib/github/app-auth`, and a test fails if anything other than `scripts/start-worker.ts` imports a module that starts a consumer.
- 0729263: `POST /api/webhooks` and `POST /api/webhooks/generic` now cap the request body at 1 MiB (configurable with the new optional `WEBHOOK_MAX_BYTES`) and answer `413` above it. The guard read the whole body with `req.text()` before checking the signature, so an unauthenticated caller could make the process buffer an unbounded body. A declared `Content-Length` over the cap is refused without reading, and the bytes actually received are counted so chunked or mislabelled bodies are cut off too. The HMAC is now verified over the body bytes exactly as received rather than over a decoded string, which also stops bodies that are not valid UTF-8 from being rejected despite a correct signature.

## 2.2.2

### Patch Changes

- 14f6d3e: Read `.secureflowignore` from the pull request's base branch instead of its head. The file decides which files the scanner skips (and the `[placeholders]` section which findings it drops), but it was fetched at the PR's own head commit, so a pull request that added a `.secureflowignore` containing `**` had every file in it, `.env` included, silently skipped and still received a passing check run. The base branch is the trust anchor, since changing it takes a merge through the repository's own review. If the base branch cannot be determined, or the file cannot be read, the scan runs without ignore rules, which can only cover more, never less. The webhook worker now passes `baseRef` and leaves ignore loading to the scan engine, so the webhook and `/api/findings` paths share one implementation.
- 5715bbf: Recommend the fix for the release line a dependency is actually on. OSV advisories list one `fixed` version per maintained branch, and the first one was always reported, so `ws@8.16.0` was told to "update to 5.2.4 or higher" (a downgrade the installed version already satisfies). The fixed version is now chosen from the range containing the installed version, ignores `GIT` ranges whose `fixed` is a commit hash, and is never lower than the installed version.
- d812a43: Keep the per-PR scan lock held for as long as the scan runs. The lock was a fixed five-minute lease with no renewal, but a scan is not bounded by that (each LLM call may take two minutes and is retried), so a slow scan lost its lock mid-run and the next delayed job for the same PR started concurrently, producing the duplicate scans and comments the lock exists to prevent. The same flat lease also blocked a PR for the full five minutes after a worker crash. The lease is now 60 seconds, renewed every 20 seconds by a heartbeat that only extends a lock it still owns (atomic compare-and-extend in Lua), and stopped before the lock is released.
- 96b64b1: Let GitHub redeliver a failed webhook, and stop keeping every webhook payload in Redis forever. The ingest route enqueues under `delivery-<id>`, and a delivery whose job exhausted its attempts keeps that job ID, so GitHub's "Redeliver" button (which reuses the delivery ID) was deduplicated against the dead job, answered `202 queued`, and never ran. Only the DLQ requeue paths knew to replace a failed job; the route now does too, while waiting, active and completed jobs still collapse a replay. Separately, `github-webhooks` was the only queue with no `removeOnComplete`/`removeOnFail`, so BullMQ kept every job, full payload included, indefinitely. It now keeps completed jobs for 24 hours and failed jobs for 48 hours, matching the scan and SBOM queues; replay safety is unaffected because completed deliveries are recorded in `WebhookEvent` and failed ones in the DLQ.

## 2.2.0

### Minor Changes

- b3620a7: Expand the landing page footer into a multi-column layout with brand block, tagline, social icons and grouped navigation. Add privacy, terms and security pages.

### Patch Changes

- 4b8d086: Add multi-format (CSV & JSON) export capabilities to the Audit Log Dashboard table with structured JSON support and export dropdown controls.
- 651f064: Add Changesets-managed CHANGELOG.md for tracking features, database migrations, and AI flow updates across Docker image versions.
- ce543d8: Add `--fail-on=<SEVERITY>` command line flag to the SecureFlow CLI to configure custom severity threshold exit criteria.
- 068e898: Add GitHub-flavored Markdown (`--format markdown` or `--format md`) report export support to the SecureFlow CLI exporter module.
- 5a20029: Add configurable minimum severity threshold filtering (`minSeverity`) to the Slack webhook notification integration module.
- 0e64a02: Analytics charts now use UTC days throughout. The date range was built from the server's local midnight while rows were bucketed by their UTC date, so on a server east of UTC the range ended on the previous day and today's scans were missing from the daily, severity and velocity charts. Adds query-level tests for `scan-history.ts` (22% → 100% line coverage).
- 5e9ffec: Fall back to `llama-3.1-8b-instant` for the PR scan when `AI_MODEL` is not set. `AI_MODEL` is optional, but the scanner passed `process.env.AI_MODEL!` straight to Groq, so a deployment without it sent requests with no model and every scan failed.
- 93e4bd8: `AuditSanitizer.serializePayload` now preserves `Date` values. `JSON.stringify` converts a Date with `toJSON()` before the replacer sees it, so the `instanceof Date` branch never matched and Dates came back from `deserializePayload` as plain strings. The replacer now reads the original value.
- 5ac22f3: Session roles are re-read from the database at least every five minutes. They were copied into the JWT at sign-in and only refreshed when missing or on an explicit `update()`, so demoting an admin (or deleting a user) had no effect on that user's existing session, which lasts a year. Every admin check reads `session.user.roles`.
- 8fa0289: Fix bulk remediation answering 403 when a finding id is repeated, and cap a request at 100 findings (one dashboard page), since each finding starts its own AI call.
- 9a4ae2f: Fix the bulk remediation bar showing a combined patch generated for a previous selection after the selected findings change.
- cddc2dd: Let only one request probe the dependency while the circuit breaker is HALF_OPEN. Every caller in flight when `resetTimeoutMs` elapsed was admitted together, so the rate limiter's Redis breaker stopped shielding callers at exactly the moment Redis was least able to answer.
- 04d8d56: Stop the CLI from uploading staged lockfiles, binaries and oversized files to the AI scan endpoint; only files the local scan reads are sent.
- ecbd83b: Neutralise spreadsheet formulas in the CLI's `--format csv` report. A file path or source line starting with `=`, `+`, `-`, `@`, TAB or CR is now prefixed with `'`, the same defence the admin audit-log export already applies, so opening the report in Excel, LibreOffice or Google Sheets no longer evaluates it.
- c491ba6: Fix `--fail-on=NONE` in the CLI. It was accepted as a valid threshold but ranked below every severity, so instead of never blocking a commit it blocked on every finding — including LOW ones the default run ignores.
- 853cf54: Correct a `.secureflowignore` glob assertion that failed the Unit Tests job: `*.test.ts` does not match a file named `test.ts`, so `src/test.ts` must not be ignored.
- 511c2b8: `secureflow --local` no longer uploads staged files to the hosted SecureFlow API. The flag promised that no code leaves the machine, but it only set `LOCAL_AI_URL` in the CLI process. The CLI's AI pass is an HTTP upload to `/api/cli/scan`, so the code was still sent. Under `--local` that pass is now skipped; the local pattern scan still runs.
- c325cbe: Fix the CLI's Markdown report corrupting flagged source lines. A backtick in the line — a template literal, which is the common shape of a logged secret — closed the code span early and spilled the rest of the line into the table as prose, and backslashes were doubled inside a span whose contents render literally.
- 2592b9e: Restore Core CI. Five type errors in the CLI's SARIF validator failed `npm ci` repo-wide — `cli`'s `prepare` script runs `tsc` — so every job on `main` and on every open pull request stopped at "Install dependencies". Also fixes a `prefer-const` lint error in the `.secureflowignore` compiler.
- c34d020: Report the findings that actually decided a CLI scan's exit code. The blocked message only counted HIGH/CRITICAL AI findings, so `--fail-on=LOW` could block on a LOW finding while announcing "0 secret-logging violations", and the advisory summary interpolated an unset threshold as `--fail-on=null`.
- c02a16a: Validate each entry of `files` on `POST /api/cli/scan`, so a missing or non-string `path`/`content` returns 400 instead of a 500 or a scan of a nameless file.
- d064a73: Make the DLQ auto-retry limit and backoff apply. A requeued webhook that failed again re-entered the DLQ as a first-time entry: the count was not carried, so it was requeued on every poll without end. The count now travels on the requeued job, and the worker writes it back onto the new DLQ entry. Separately, a failed `remove()` no longer re-inserts a duplicate entry.
- 0fc24d6: Make DLQ requeues actually re-run the webhook. The failed original still held its `delivery-<id>` job id in the main queue, so BullMQ deduplicated the requeue against it and nothing was added — for both the admin "Requeue" actions and the automated DLQ retry worker.
- 03b3b67: Fix the explain-stream endpoint crashing with a `ReferenceError` whenever a cached AI explanation is found, so cache hits now stream the cached result instead of failing the request.
- 22e60b8: Fix `/api/findings/[id]/explain-stream` returning 500 for every request: the finding lookup selected fields that do not exist on the `Finding` model (`file`, `description`, `line`, `aiExplanation`), which Prisma rejects at runtime. The lookup now selects `fileLocation` and the owning user in one query, and again answers 404 for a missing finding and 403 for another user's finding.
- 8d84863: The security-explanation fallback chain now uses models Groq still serves (`openai/gpt-oss-120b`, `qwen/qwen3.6-27b`). All three previous fallbacks are shut down (`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on 2026-08-16, `mixtral-8x7b-32768` on 2025-03-20), so a rate-limited or timed-out primary model failed outright instead of failing over.
- fbad878: Show the Dependency Security card on the findings page. It filtered on a `DEPENDENCY_VULNERABILITY` finding type that does not exist (the SBOM worker stores dependency findings as `VULNERABILITY` with a `Dependency: name@version` snippet), so it never rendered. The card is now built from those rows, using the fields the page actually loads.
- ddc8671: Keep what the user typed in the findings search box when the debounced search is applied. The URL stores the trimmed term, and syncing the box back from it removed a trailing space, so pausing after "api " left "api" in the box before the next word. The debounce also no longer re-applies a term the URL already holds.
- ef5b712: With `AI_MODEL` unset, the Genkit instance and the heist transmission now default to `openai/gpt-oss-20b`, the default documented in `genkit.ts`, instead of `llama-3.1-8b-instant`, which the same file notes Groq deprecated. `defaultModel` also no longer turns a blank `AI_MODEL` into `groq/`, or an already-namespaced id into `groq/groq/…`.
- c846c06: Prefix `AI_MODEL` with the `groq/` namespace before handing it to Genkit. The documented value (`AI_MODEL=openai/gpt-oss-20b`) is a bare Groq id, which Genkit rejects with `NOT_FOUND`, so the heist message stream and the first model of the security-explanation fallback chain failed whenever `AI_MODEL` was set.
- 4401eae: The Groq SDK callers (PR scan, streamed explanations, prompt-injection classifier) now default to `openai/gpt-oss-20b` when `AI_MODEL` is unset, instead of `llama-3.1-8b-instant`, which Groq shut down on 2026-08-16. `docs/setup.md` and the README recommended the same retired model.
- 9ff8b5c: `/api/health` no longer calls Groq with the server's API key on every request. The endpoint is public and exempt from rate limiting, so anyone could use it to send an unlimited stream of authenticated requests on that key. The Groq probe result is now reused for 60 seconds, and concurrent checks share one request. Adds tests for `health-check.ts` (0% → 100%).
- 992da71: `/api/health` no longer returns raw component error messages to anonymous callers. Prisma's messages include the database host and port, and ioredis's describe the client's retry settings. Monitors still get each component's status and latency. Signed-in users, including the `/dashboard/status` refresh, still see the messages.
- 6baf966: Stop the public leaderboard endpoint from returning raw database error messages, which can name the database host, to unauthenticated callers over JSON and SSE.
- 590df7f: Fix local-model mode (`LOCAL_AI_URL`). `local-model.ts` imported a named `openAI` from `@genkit-ai/compat-oai`, which the package does not export, so building the local Genkit instance threw `openAI is not a function`. It now uses `openAICompatible` with the configured `baseURL`. This also clears the `npx tsc --noEmit` failure on `main`.
- 37c0cb2: Add a `.prettierignore` so `format:check` skips generated output. Prettier only reads the root `.gitignore`, so the compiled CLI in `cli/dist` was being checked — which made `.husky/pre-commit` unpassable, since its `npm run secureflow` step needs the very directory its `format:check` step rejected.
- 9e63c19: Look through every page of the signed-in user's GitHub App installations when resolving the installation from their OAuth token. Only the first 10 were read, so a user in more than ten organisations could be told the app was not installed and get no repositories synced.
- fda146b: Declare `timeoutMs` on `RetryConfig` so the per-attempt AI timeout added in #988 type-checks and is actually configurable, and name the 15s default `DEFAULT_ATTEMPT_TIMEOUT_MS`.
- 1140c01: Fix SBOM scan deduplication never matching an earlier enqueue: the audit lookup used a different `action` casing than the sanitizer stores, and the stored dedupe key had its commit SHA redacted.
- 167252a: Read npm version specifiers properly when building the SBOM. Stripping one leading character turned `>=1.2.3` into `=1.2.3` and `latest` into `atest`; OSV matches no advisory against a malformed version, so those dependencies were reported clean. `<4.17.21` was dropped to `4.17.21` and queried as the installed version.
- a47300e: Authenticate PR manifest SBOM scanning as the GitHub App installation. It built its Octokit from `GITHUB_TOKEN`, a variable that is in no env schema and set nowhere, so the client was anonymous — manifests in private repositories 404ed and the scan silently found nothing.
- 2238fd3: When a completed SBOM job is retried and its result has to be rebuilt from the database, only that manifest's dependency findings are used. The rebuild used to take the pull request's latest `ScanResult` whole, which could be the code scan or another manifest's scan. It also split scoped npm names (`@scope/pkg@1.0.0`) at the wrong `@`. A clean completed scan is now recovered from its ScanJob row instead of failing as unrecoverable.
- 8a6dc18: Stop the SBOM scan reporting `CLEAN` / `PASS` for a manifest it could not read. `POST /api/sbom/scan` now rejects file names other than `package.json` and `requirements.txt` with 400, and the SBOM worker marks the scan job `FAILED` for an unsupported manifest or a `package.json` that is not a JSON object (for example `null` or `[]`), instead of completing it with zero dependencies.
- 2199495: Fix pull request SBOM scans never being queued: the webhook built BullMQ job ids containing `:`, which BullMQ rejects, so every manifest scan failed before reaching the worker.
- 7cb672c: Fix SBOM scans that hit a transient error reporting CLEAN on retry: the worker now returns the ScanJob to PENDING so the retry can claim it and actually scan the manifest.
- 78d961e: Fail a scan when a chunk of the pull request cannot be analysed, instead of skipping that chunk. `processScanJob` caught the error `scanner.scanPullRequest` throws once its retries are exhausted and carried on, so an unavailable LLM produced a `PASS` check run with zero findings on both the webhook and the queued scan paths. It now throws `ScanIncompleteError`, which fails the job.
- d0752e3: Scan jobs that fail with `UnrecoverableError` (a results-persistence failure or an unusable installation id) are now recorded in the scan DLQ. BullMQ ends the retry chain after that first attempt, so `attemptsMade` (1) never reached `attempts` (2), and those jobs disappeared without a DLQ entry. The outbound and SBOM workers already handled this case.
- 3c5e6a8: The scan worker now uses the `SCAN_WORKER_CONCURRENCY` value validated at startup. `scanWorkerPool` re-read the variable with a bare `parseInt`, so an empty value (`SCAN_WORKER_CONCURRENCY=`) passed validation (falling back to 3), but it reached BullMQ as `NaN` and crashed the worker process with `concurrency must be a finite number greater than 0`.
- d399998: The BullMQ and rate-limit Redis clients no longer share a development-time singleton. Both cached themselves on `globalThis.redis`, so outside production whichever module loaded first handed its client to the other, and a BullMQ `Worker` given the rate-limit client (`maxRetriesPerRequest: 3`) throws. The rate limiter and health probe could also end up with the queue's never-give-up client, or with its `NEXT_PUBLIC_MOCK_DB` stub.
- b2eed5b: Read `/share/heist` links with the same parsers as the `/api/og/heist` preview card. The page and its metadata used the raw query, so `score=150` was described as 150 beside a card showing 100, `score=` was ranked D, and the title carried the uncapped, unsanitised project name. Repeated parameters now use their first value.
- c4d884d: Keep the Slack alert within Block Kit's 3,000-character section limit. Ten findings at the summary cap produced a ~4,000-character section, which Slack rejects as `invalid_blocks` — so the alert with the most findings was the one that never arrived.
- bab6ca7: Show the stored explanation when a live analysis fails partway. The panel said "Showing last known analysis" but kept displaying the fragment that arrived before the stream broke.
- 5239064: Correct the README after `TRUSTED_PROXY_HOP_COUNT` changed its default to `0` (it still said `1`, "the default" for Vercel), and log a one-time warning when forwarding headers arrive while neither `TRUSTED_PROXY_HOP_COUNT` nor `TRUSTED_PROXY_IPS` is set, because every client then shares one rate-limit bucket.
- 1b77364: `useTypewriter` restarts when its text is replaced instead of extended. It kept its character index across texts, so a shorter replacement never started typing (the previous text stayed on screen), and a longer one jumped straight to the old position.
- ddc899a: Fix pull request SBOM scans missing manifests beyond the first 30 changed files: the webhook now pages through the PR's files, as the PR scan worker already does.
- 42c3157: Fix pull request SBOM scans reading manifests by branch name on the base repository, which skipped fork PRs (404) or scanned an unrelated base branch; manifests are now read at the PR's head commit.
- f27d828: Stop the webhook scan requesting every AI explanation twice. `processScanJob` explained each active finding, and the webhook worker then discarded those results and explained the same findings again before posting. The engine takes a new `enrich` option, and the worker passes `enrich: false`.
- 1034d39: Restore dependency (SBOM) scanning of pull request manifests. #927 stopped the webhook route running `handlePullRequestSynchronize` inline so that the worker would own each delivery, but the worker never called it, so changed `package.json` / `requirements.txt` files were no longer scanned. The worker now runs it for `pull_request` `synchronize` deliveries, from `src/lib/sbom/pull-request-manifests.ts`.
- 02c6378: Cover `src/lib/utils/exportCsv.ts`, the audit log's client-side download helper, which shipped at 0% — including the BOM, the shared formula-injection defence, and the object-URL release on a failed click.
