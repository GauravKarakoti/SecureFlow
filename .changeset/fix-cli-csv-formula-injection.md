---
"secureflow-cli": patch
---

Neutralise spreadsheet formulas in the CLI's `--format csv` report. A file path or source line starting with `=`, `+`, `-`, `@`, TAB or CR is now prefixed with `'`, the same defence the admin audit-log export already applies, so opening the report in Excel, LibreOffice or Google Sheets no longer evaluates it.
