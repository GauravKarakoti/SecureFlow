---
"secureflow-cli": minor
---

Add `secureflow init` command to generate a commented `.secureflow.json` configuration file with interactive and `--yes` modes, covering scan paths, minimum severity thresholds, and AI remediation toggles. Refuses to overwrite existing configurations without `--force`, and ensures scan accepts the generated configuration.
