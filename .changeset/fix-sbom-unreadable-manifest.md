---
"secureflow": patch
---

Stop the SBOM scan reporting `CLEAN` / `PASS` for a manifest it could not read. `POST /api/sbom/scan` now rejects file names other than `package.json` and `requirements.txt` with 400, and the SBOM worker marks the scan job `FAILED` for an unsupported manifest or a `package.json` that is not a JSON object (for example `null` or `[]`), instead of completing it with zero dependencies.
