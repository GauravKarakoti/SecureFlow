# Security Policy

SecureFlow is a security-scanning tool, so we take reports about SecureFlow's
own security seriously. This document explains what versions receive fixes and
how to report a vulnerability responsibly.

## Supported Versions

SecureFlow is developed on a single rolling `main` branch and does not yet
publish versioned releases with parallel maintenance branches. Security fixes
are applied to `main` and deployed from there.

| Version / Branch    | Supported          |
| ------------------- | ------------------ |
| `main`              | :white_check_mark: |
| Older commits/forks | :x:                |

If this changes (for example, once tagged releases are introduced), this table
will be updated to reflect which versions continue to receive security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.** Publicly disclosing an unpatched
vulnerability puts every user of the project at risk before a fix is
available.

Instead, please report it privately using **GitHub's private vulnerability
reporting** feature for this repository:

👉 <https://github.com/GauravKarakoti/SecureFlow/security/advisories/new>

This is also the mechanism linked from the repository's issue template
chooser, so it is the canonical way to reach the maintainers about a security
concern. Reporting this way opens a private advisory that only you and the
maintainers can see until a fix is ready.

If you are unable to use GitHub's private reporting workflow for any reason,
please open a [GitHub Discussion](https://github.com/GauravKarakoti/SecureFlow/discussions)
asking a maintainer to reach out, **without including any vulnerability
details or proof-of-concept code** in that request. A maintainer will follow
up with a private channel for the full report.

### What to include in your report

To help us triage and fix the issue quickly, please include as much of the
following as you can:

- A clear description of the vulnerability and its potential impact.
- The affected component, file(s), or endpoint(s).
- Step-by-step instructions to reproduce the issue, including any required
  configuration.
- Proof-of-concept code, request/response samples, or screenshots, if
  applicable.
- Any known mitigations or workarounds.

### What to expect after reporting

- We will acknowledge your report as soon as we are able to.
- We will investigate and keep you updated on our assessment and progress.
- Once a fix is available, we will coordinate with you on disclosure timing
  and, where appropriate, credit you for the finding.
- If a report is declined (for example, because it describes expected/by-design
  behavior or is out of scope), we will explain why.

## Responsible Disclosure

We ask that you:

- Give us a reasonable amount of time to investigate and address a report
  before disclosing it publicly.
- Make a good-faith effort to avoid privacy violations, data destruction, and
  interruption or degradation of the service while investigating.
- Only interact with accounts, data, and repositories you own or have explicit
  permission to test.

We commit to working with security researchers in good faith and will not
pursue legal action against reports made in accordance with this policy.

## Related Security Documentation

SecureFlow also maintains implementation-level security documentation for
specific subsystems, which may be useful background when reporting an issue in
one of these areas:

- [Prompt injection in AI-generated explanations](docs/security/prompt-injection.md)
- [HTTP security response headers](docs/security/response-headers.md)
- [API rate limiting](docs/security/rate-limiting.md)
- [Outbound webhook dispatch](docs/security/outbound-webhooks.md)

These documents describe existing defenses and are not a substitute for
privately reporting a suspected vulnerability as described above.