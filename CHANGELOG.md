# Changelog

All notable changes to the SecureFlow application, API services, and infrastructure deployments are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> Note: For changes specific to the command-line interface tool, please see [`cli/CHANGELOG.md`](cli/CHANGELOG.md).

---

## [Unreleased]

### Added
- Root-level centralized `CHANGELOG.md` to track full application releases, API route updates, database migrations, and Helm charts independently from `cli/CHANGELOG.md` ([#1268](https://github.com/GauravKarakoti/SecureFlow/issues/1268)).
- Threat Intelligence MCP server integration providing real-time CVE and vulnerability context to the remediation engine ([#1200](https://github.com/GauravKarakoti/SecureFlow/issues/1200)).
- "Hold for Approval" human-in-the-loop workflow for high-risk CI/CD policy actions and deployments ([#1199](https://github.com/GauravKarakoti/SecureFlow/issues/1199)).
- Complete ArmorIQ integration supporting dynamic policy token authentication and compliance audits ([#1196](https://github.com/GauravKarakoti/SecureFlow/issues/1196)).
- Dedicated AI eval GitHub Action workflow (`ai-eval.yml`) isolating LLM red-team and prompt-guard tests from standard CI ([#1244](https://github.com/GauravKarakoti/SecureFlow/issues/1244)).
- Real-time Server-Sent Events (SSE) streaming support for the system status dashboard route (`/api/health?stream=true`) ([#994](https://github.com/GauravKarakoti/SecureFlow/issues/994)).

### Fixed
- Enforce authoritative pull request diff validation on `/api/findings` to prevent caller-supplied file spoofing ([#1155](https://github.com/GauravKarakoti/SecureFlow/issues/1155)).
- Upstream Groq LLM rate-limit (429) and timeout failover handling across secondary and tertiary model chains in scanner and AI flows ([#1182](https://github.com/GauravKarakoti/SecureFlow/issues/1182)).
- Enforced route-specific Redis rate limiting across AI, authentication, and general endpoints in proxy middleware ([#1243](https://github.com/GauravKarakoti/SecureFlow/issues/1243)).

---

## [0.1.0] - 2026-09-15

### Added
- Initial core release of SecureFlow enterprise application platform.
- Next.js 15 App Router web dashboard with real-time security findings, analytics, audit log viewer, and policy manager.
- BullMQ Redis-backed worker queues for asynchronous vulnerability scans and SBOM generation.
- Static secret-detection engine and LLM-assisted vulnerability analysis powered by Groq.
- GitHub App webhook integration supporting automated pull request security reviews and inline comments.
- Helm chart (`helm/secureflow`) deployment configs for Kubernetes clusters with StatefulSet Redis, PostgreSQL hooks, and ServiceMonitors.
- Interactive Leaderboard, Heist transmission simulation, and bulk remediation workflows.
- Dynamic SARIF, JSON, and CSV export capabilities.
