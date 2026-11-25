---
"secureflow": minor
---

feat(rules): license compliance check for newly added dependencies (#2093)

- Implemented deterministic license compliance checks in `src/lib/rules/license-rules.ts`.
- Inspects newly added dependencies in manifest and lockfiles (`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`).
- Compares dependency licenses with a per-repository `allowList` and `denyList` configured in `.secureflow.json`.
- Reports denied licenses as findings with package name and SPDX license ID (`SEC_LICENSE_DENIED`).
- Reports unknown licenses as `'unknown'` (`SEC_LICENSE_UNKNOWN`) and does not treat them as denied.
- Operates offline and deterministic by default without external registry calls, supported by offline known package dictionary and optional `packageLicenseOverrides`.
- Integrated into `gate-config.ts`, `armor/scanner.ts`, and `scanner/scanEngine.ts`.
- Added comprehensive unit tests in `src/lib/rules/license-rules.test.ts`.
