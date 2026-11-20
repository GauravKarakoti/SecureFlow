---
"secureflow": patch
---

Add Playwright visual regression snapshot testing for key dashboard pages (#1871).
- Added `toHaveScreenshot` snapshot test suite (`e2e/visual-regression.spec.ts`) for key dashboard pages with masked dynamic content, frozen clock, and disabled animations.
- Stored baseline snapshots in `e2e/__screenshots__/`.
- Added dedicated `test:visual` and `test:visual:update` scripts.
- Added opt-in CI workflow (`.github/workflows/visual-regression.yml`) with automated diff artifact uploading on failure.
- Documented baseline review and update procedures in `CONTRIBUTING.md`.
