# 🛡️ SecureFlow CLI (`secureflow-cli`)

[![npm version](https://img.shields.io/npm/v/secureflow-cli.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/secureflow-cli)
[![license](https://img.shields.io/npm/l/secureflow-cli.svg?style=flat-square&color=green)](https://github.com/GauravKarakoti/SecureFlow/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Enabled-purple?style=flat-square)](https://modelcontextprotocol.io/)

**Pre-commit secret logging detector, AI vulnerability scanner, and Threat Intelligence MCP Server for modern developer workflows.**

The SecureFlow CLI intercepts code vulnerabilities and exposed secrets right at the developer terminal before commits reach remote repositories. It operates in both cloud-assisted and completely offline / air-gapped modes, features audio debriefs, and acts as an MCP server for AI coding assistants.

---

## 📋 Table of Contents

- [🌟 Features](#-features)
- [📦 Installation](#-installation)
- [🚀 Quick Start](#-quick-start)
- [🪝 Git Hook Setup (Husky)](#-git-hook-setup-husky)
- [📖 Command Line Reference](#-command-line-reference)
  - [Options & Flags](#options--flags)
  - [Failure Thresholds (`--fail-on`)](#failure-thresholds---fail-on)
  - [Multi-Format Reports (`--format`)](#multi-format-reports---format)
- [🔒 Air-Gapped & Local Mode (`--local`)](#-air-gapped--local-mode---local)
- [🎙️ Audio Summary Debriefs (`--voice`)](#️-audio-summary-debriefs---voice)
- [🤖 Threat Intelligence MCP Server (`mcp`)](#-threat-intelligence-mcp-server-mcp)
  - [Connecting to Cursor / Windsurf / Claude Desktop](#connecting-to-cursor--windsurf--claude-desktop)
  - [Available MCP Tools](#available-mcp-tools)
- [⚙️ Configuration (`.secureflowignore`)](#️-configuration-secureflowignore)
- [🛠️ Custom Security Rules (`.secureflow.json`)](#️-custom-security-rules-secureflowjson)
- [🔄 CI/CD Pipeline Integration](#-cicd-pipeline-integration)
- [🎨 Terminal Color Support & NO_COLOR](#-terminal-color-support--no_color)
- [📄 License](#-license)

---

## 🌟 Features

- **⚡ Instant Pre-Commit Scans**: Evaluates staged git files in milliseconds to prevent accidental secret leaks and credential logging.
- **🧠 Hybrid AI Security Analysis**: Combines deterministic heuristic pattern matching with LLM-backed vulnerability reasoning.
- **🔐 Air-Gapped / Zero-Upload Mode**: Run with `--local` to guarantee that code snippets never leave your workstation.
- **🎙️ Voice Debriefs (`--voice` / `-v`)**: Audio debriefs of scan findings directly in your terminal upon scan completion, with automatic headless CI bypass.
- **🤖 Built-in MCP Server**: `secureflow mcp` exposes live threat intelligence, CVE lookups, and ArmorIQ cryptographic intent verification over JSON-RPC stdio.
- **📊 Comprehensive Exporters**: Export audit-grade reports in **SARIF** (GitHub Code Scanning), **HTML**, **CSV** (formula injection hardened), **JSON**, and **Markdown**.
- **🚦 Configurable Quality Gates**: Strict build-failing control using `--fail-on <low|medium|high|critical>`.

---

## 📦 Installation

### Global Installation (Recommended)

```bash
npm install -g secureflow-cli
```

### Project Dev Dependency

```bash
npm install --save-dev secureflow-cli
```

### Run Instantly via `npx`

```bash
npx secureflow --help
```

---

## 🚀 Quick Start

1. **Stage your changes in git:**

   ```bash
   git add src/
   ```

2. **Run the security scanner:**

   ```bash
   secureflow
   ```

3. **Run with an audio summary debrief:**

   ```bash
   secureflow --voice
   ```

4. **Export a SARIF report for GitHub Code Scanning:**
   ```bash
   secureflow --format sarif -o results.sarif
   ```

---

## 🪝 Git Hook Setup (Husky)

Prevent sensitive data from ever entering your git history by configuring SecureFlow in your pre-commit hook:

```bash
# Initialize husky in your project
npx husky init

# Add secureflow to your pre-commit hook
echo "npx secureflow --fail-on high" > .husky/pre-commit
```

Now, every `git commit` automatically triggers a security check on staged files. If a high or critical finding is detected, the commit is safely blocked.

---

## 📖 Command Line Reference

```text
Usage:
  secureflow [options]
  secureflow doctor [options]
  secureflow watch [path] [options]
  secureflow validate [file] [options]
  secureflow mcp [options]
  secureflow sbom <file> [options]
  secureflow explain --web3 [options]

Commands:
  doctor                 Run pre-scan diagnostics on Node version, git, config, and AI endpoint reachability
  watch [path]           Watch workspace for file changes and rescan continuously in real time
  validate [file]        Validate .secureflow.json and .secureflowignore against schema with line-numbered reports
  mcp                    Start the Threat Intelligence Model Context Protocol (MCP) server over stdio
  sbom <file>            Scan software bill of materials (package.json, requirements.txt) for vulnerabilities
  explain --web3         Generate AI security analysis and remediation for Web3 / Smart Contract findings
```

### Options & Flags

| Flag                   | Shorthand | Default             | Description                                                                                                                 |
| :--------------------- | :-------- | :------------------ | :-------------------------------------------------------------------------------------------------------------------------- |
| `--init`               |           |                     | Initialize SecureFlow (wizard for git hooks, `.secureflow.json`, and `.secureflowignore`)                                   |
| `--watch`              | `-w`      | `false`             | Watch workspace for file changes and rescan modified files in real time                                                     |
| `--validate [file]`    |           |                     | Validate `.secureflow.json` and `.secureflowignore` against shared schemas with line-numbered errors                        |
| `--force`              | `-f`      | `false`             | Overwrite existing `.secureflow.json` and `.secureflowignore` without confirmation prompt                                   |
| `--severity <level>`   |           | `HIGH`              | Minimum blocking severity threshold for `init` (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `NONE`)                                |
| `--ignore <paths>`     |           |                     | Comma-separated paths/globs to ignore for `init`                                                                            |
| `--languages <langs>`  |           |                     | Comma-separated repository languages for `init` (e.g. `typescript,terraform,python`)                                        |
| `--husky`              |           |                     | Initialize pre-commit hook using Husky (`.husky/pre-commit`)                                                                |
| `--blank`              |           |                     | Initialize pre-commit hook using `package.json` prepare script                                                              |
| `--fail-on <level>`    |           | `HIGH`              | Threshold to fail scan (`critical`, `high`, `medium`, `low`, `none`). Exits 0 below threshold, 1 when met, 2 on scan errors |
| `--format <format>`    |           | `text`              | Output report format: `text`, `json`, `sarif`, `csv`, `html`, `markdown`                                                    |
| `--output <path>`      | `-o`      | `stdout`            | Write report to the specified file path                                                                                     |
| `--poll`               |           | `false`             | Poll SBOM scan status until background worker processing completes                                                          |
| `--file <path>`        |           |                     | Target file for smart contract analysis with `explain --web3`                                                               |
| `--finding-type <id>`  |           |                     | Vulnerability type (e.g. Reentrancy, Overflow) for `explain --web3`                                                         |
| `--voice`              | `-v`      | `false`             | Play an audio debrief of findings in your terminal upon completion                                                          |
| `--local`              |           | `false`             | Skip cloud AI upload and run fully local pattern analysis                                                                   |
| `--local-model <tag>`  |           | `llama3`            | Specify local model tag when using local AI providers                                                                       |
| `--config <path>`      | `-c`      | `.secureflow.json`  | Custom path to `.secureflow.json` configuration file                                                                        |
| `--ignore-file <path>` |           | `.secureflowignore` | Custom path to ignore configuration file                                                                                    |
| `--dry-run`            |           | `false`             | Simulate scan execution without writing output files                                                                        |
| `--color`              |           |                     | Force colored output even on non-TTY terminals (pipes / redirects)                                                          |
| `--no-color`           |           |                     | Disable colored output (ANSI escape codes)                                                                                  |
| `--quiet`              | `-q`      | `false`             | Print only the summary and errors                                                                                           |
| `--verbose`            |           | `false`             | Enable verbose logging (per-file timing and skipped files)                                                                  |
| `--help`               | `-h`      |                     | Display CLI usage instructions and exit                                                                                     |

---

### 📦 SBOM Scanning (`secureflow sbom`)

Scan third-party dependencies directly against OSV vulnerability databases via background queue processing:

```bash
# Enqueue a scan for a package.json manifest
secureflow sbom package.json

# Enqueue and poll until background scan finishes
secureflow sbom requirements.txt --poll
```

---

### 🧠 Web3 Security Explanations (`secureflow explain --web3`)

Audit smart contracts (Solidity, Soroban/Rust, Circom, Leo) with domain-specific AI analysis and remediation patterns:

```bash
# Analyze a Solidity contract for reentrancy vectors
secureflow explain --web3 --file contracts/Vault.sol --finding-type Reentrancy
```

---

### Failure Thresholds (`--fail-on`)

Control the sensitivity of the pre-commit gate and CI pipelines by specifying the minimum severity required to fail:

```bash
# Block only on high and critical findings (standard CI recommendation)
secureflow scan --fail-on high

# Strict zero-tolerance gate (blocks on any finding, including low)
secureflow scan --fail-on low

# Allow commits while logging warnings (advisory mode)
secureflow scan --fail-on none
```

#### Exit Codes

SecureFlow CLI returns deterministic exit codes designed for automated CI/CD pipeline integration:

| Exit Code | Status                      | Description                                                                                                               |
| :-------: | :-------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
|    `0`    | **Success / Pass**          | All findings are strictly below the `--fail-on` threshold, or no security violations were detected.                       |
|    `1`    | **Threshold Met / Blocked** | Findings at or above the `--fail-on` threshold were detected (e.g. `HIGH` or `CRITICAL` findings under `--fail-on high`). |
|    `2`    | **Scan Error**              | Execution encountered a scan error (e.g. git error, missing repository, or unreadable scan tree).                         |

> **Default Behavior:** When `--fail-on` is omitted, SecureFlow defaults to blocking on `HIGH` or `CRITICAL` findings (exit code `1`), passing on clean or `LOW`/`MEDIUM` findings (exit code `0`), and exiting `1` on errors.

#### Severity Summary Output

Before exiting, SecureFlow outputs a concise one-line count of findings per severity:

```text
Findings by severity: critical: 0, high: 2, medium: 1, low: 0
```

---

### Multi-Format Reports (`--format`)

- **Text (`text`)**: Clean, ANSI-colored terminal overview with source code context snippets.
- **SARIF (`sarif`)**: Industry-standard OASIS SARIF 2.1.0 format, ready for direct upload to GitHub Security tab (GHAS). Maps findings to standard rules, locations, and severities (`error`, `warning`, `note`).
- **HTML (`html`)**: Self-contained, responsive HTML report suitable for sharing and compliance reviews.
- **CSV (`csv`)**: Formatted tabular output hardened against spreadsheet formula injection (CWE-1236).
- **JSON (`json`)**: Machine-readable JSON object representing findings and metadata.
- **Markdown (`markdown` / `md`)**: GitHub-Flavored Markdown summary with severity counts and findings table (secrets masked).
- **JUnit (`junit`)**: Standard JUnit XML test report mapping findings to test cases for native rendering in CI/CD platforms (failures for blocking severities).

```bash
secureflow --format html -o security-report.html
secureflow --format sarif -o results.sarif
secureflow --format markdown -o findings.md
secureflow --format junit -o test-results.xml
```

#### GitHub Advanced Security (GHAS) Integration (#1766)

Directly upload generated SARIF scan reports into your GitHub Code Scanning alerts tab:

```yaml
name: Security Scan
on: [push, pull_request]

jobs:
  secureflow-scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Run SecureFlow CLI Scan
        run: npx secureflow-cli --format sarif -o results.sarif --fail-on high
      - name: Upload SARIF to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
          category: secureflow-analysis
```

SARIF findings exported by SecureFlow conform strictly to OASIS SARIF v2.1.0 specifications and include:

- Normalized relative file URIs
- Precise line ranges and character columns
- Standard GitHub severity mappings (`CRITICAL`/`HIGH` -> `error`, `MEDIUM` -> `warning`, `LOW`/`INFO` -> `note`)
- Cryptographic code snippet fingerprints for tracking issues across code refactors
- Automated remediation patch replacements within SARIF `fixes` arrays

---

## 🩺 Pre-Scan Diagnostics (`doctor`)

Diagnose and verify your development or CI environment upfront to eliminate setup surprises before scanning:

```bash
secureflow doctor
```

### Diagnostics Checked:

- **Node.js Runtime**: Ensures Node.js >= 20.0.0.
- **Git Availability**: Checks git CLI presence and whether the current directory is inside a valid git repository.
- **Configuration**: Verifies that `.secureflow.json` exists and validates its schema syntax.
- **AI Endpoint Reachability & VRAM**: Pings the configured AI provider endpoint (or local Ollama/vLLM server), reporting available VRAM/system memory for local inference.
- **Credential Safety**: All API keys, tokens, and secrets are strictly redacted (`[REDACTED]`) from diagnostic messages and logs.
- **CI / Non-Zero Exit**: Every check executes and reports independently. Returns exit code `0` when all checks pass or warn, and `1` if any check fails.
- **QNX SDP 8.0 (QNX projects only)**: Checks `QNX_HOST`, `QNX_TARGET`, `qcc` / `q++`, the SDP version and a QEMU or target connection. No QNX tool is run and no license is checked.

```bash
# Require a working QNX 8.0 toolchain
secureflow doctor --qnx

# Test a TCP connection to a QEMU or hardware target (default port 8000)
secureflow doctor --qnx-target 192.168.122.10
```

See [QNX SDP 8.0 Toolchain](https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/qnx-toolchain.md) for the full list of checks and the build and run steps.

## 👀 Real-Time Watch Mode (`--watch`)

Developers fixing security findings no longer need to rerun the full scan by hand after each edit. Watch mode monitors your workspace in real-time, automatically debounces rapid file saves, and rescans only the modified file:

```bash
secureflow --watch
# or shorthand
secureflow -w
```

### Key Features:

- **Instant Incremental Rescan**: When a file is edited and saved, only that file is rescanned.
- **Smart Debouncing**: Rapid editor autosaves and flushes within 200ms are coalesced into a single rescan.
- **Live Finding Resolution**: As soon as a vulnerability or secret logging call is fixed or removed, SecureFlow reports it as resolved:
  ```text
  ✨ Resolved: [HIGH] console-secret-logging in src/auth.ts:12
     Fixed: console.log(process.env.API_KEY);
  ```
- **New Finding Detection**: Any newly introduced vulnerability or secret is surfaced immediately:
  ```text
  ⚠️  New finding: [HIGH] console-secret-logging in src/auth.ts:15
     console.log(process.env.NEW_KEY) (secret logging)
  ```
- **Line Shift Stability**: Adding comments or restructuring code above an existing violation does not produce spurious "resolved" and "new" notifications.
- **Excluded Build Artifacts**: Directories such as `node_modules`, `dist`, `build`, `.next`, `.turbo`, and temporary files are automatically ignored.
- **Graceful Termination**: Clean shutdown on `Ctrl+C` (`SIGINT`).

---

## 🔒 Air-Gapped & Local Mode (`--local`)

When handling proprietary or classified source code, use the `--local` flag:

```bash
secureflow --local
```

### Guarantees under `--local`:

- **Zero Cloud Uploads**: The hosted AI API pass (`/api/cli/scan`) is completely bypassed.
- **Staged Code Stays Local**: File contents are parsed and scanned strictly in-memory on your local machine.
- **Compatible with Local Models**: Seamlessly pairs with local Ollama or vLLM deployments (`--local-model <tag>`).

For hardware requirements, VRAM sizing, and fallback configuration, see the [Local Model & VRAM Guide](../../docs/local-inference.md).

---

## 🎙️ Audio Summary Debriefs (`--voice`)

Listen to hands-free voice briefings of scan findings right in your terminal:

```bash
secureflow --voice
# or shorthand
secureflow -v
```

### Capabilities:

- **Native OS Playback**:
  - macOS: `afplay`
  - Windows: PowerShell `System.Media.SoundPlayer` / `Windows.Media.Playback`
  - Linux: `mpg123` or `aplay`
- **Fallback**: Automatically saves findings to `secureflow-summary.mp3` if no audio player is present.
- **CI Safe**: Detects non-interactive environments (`CI=true`, `GITHUB_ACTIONS=true`) and silently skips playback without stalling build runners.
- **ElevenLabs Integration**: Synthesizes natural voice summaries if `ELEVENLABS_API_KEY` is present.

---

## 🤖 Threat Intelligence MCP Server (`mcp`)

SecureFlow CLI doubles as a **Model Context Protocol (MCP)** server, allowing AI agents in **Cursor**, **Windsurf**, **Claude Desktop**, or **Antigravity** to query threat intelligence and verify tool actions against ArmorIQ policy boundaries.

```bash
secureflow mcp
```

### Connecting to Cursor / Windsurf / Claude Desktop

Add this configuration to your `claude_desktop_config.json` or Cursor MCP settings:

```json
{
  "mcpServers": {
    "secureflow": {
      "command": "npx",
      "args": ["-y", "secureflow-cli", "mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool                        | Parameters                              | Description                                                                                                                                                     |
| :-------------------------- | :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query_threat_intelligence` | `query: string`, `intentToken?: string` | Search CVE and threat intelligence databases for vulnerabilities and remediation guidance. Returns `threatIntelSource` ("live" \| "cache" \| "stale-fallback"). |
| `lookup_cve`                | `cveId: string`, `intentToken?: string` | Look up detailed advisories, severity scores, and fix patterns for a CVE or CWE identifier with offline/stale SWR fallback.                                     |

_All MCP tool calls are gated behind ArmorIQ cryptographic intent verification to enforce zero-trust boundary compliance and mitigate Prompt Injection (CWE-94)._

For comprehensive IDE configuration steps, intent signing keys, and manual testing instructions, see the dedicated [Threat Intelligence MCP Server Guide](../../docs/mcp-server.md).

---

## ⚙️ Configuration (`.secureflowignore`)

Define exclusion patterns and placeholder allowances in `.secureflowignore` at the root of your project:

```gitignore
# Ignore specific directories and generated bundles
dist/
coverage/
node_modules/
*.min.js

# Ignore documentation examples
docs/samples/**

# Allow safe mock/test tokens
[placeholders]
mock-token-*
test_api_key_dummy
EXAMPLE_SECRET
```

---

## 🛠️ Custom Security Rules (`.secureflow.json`)

Teams can define project-specific security rules in `.secureflow.json` to detect internal token formats, banned APIs, or proprietary coding patterns that generic scanners miss.

```json
{
  "rules": [
    {
      "id": "internal-auth-token",
      "pattern": "SEC_AUTH_[A-Za-z0-9]{32}",
      "globs": ["**/*.ts", "**/*.js"],
      "severity": "CRITICAL",
      "message": "Internal authentication token detected in source code"
    },
    {
      "id": "banned-eval-api",
      "pattern": "\\beval\\s*\\(",
      "globs": ["src/**/*.js"],
      "severity": "HIGH",
      "message": "Direct invocation of eval() is strictly prohibited"
    }
  ]
}
```

### Rule Properties

| Property    | Type       | Required | Description                                                           |
| :---------- | :--------- | :------- | :-------------------------------------------------------------------- |
| `id`        | `string`   | Yes      | Unique identifier (alphanumeric characters, dashes, and underscores)  |
| `pattern`   | `string`   | Yes      | Regular expression pattern to search for                              |
| `globs`     | `string[]` | Yes      | File glob patterns to include (e.g. `["**/*.ts", "**/*.js"]`)         |
| `severity`  | `string`   | Yes      | Finding severity: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or `INFO`      |
| `message`   | `string`   | Yes      | Human-readable explanation and remediation hint                       |
| `timeoutMs` | `number`   | No       | Regex evaluation timeout in milliseconds per file (default: `100` ms) |

### ReDoS & Catastrophic Backtracking Protection

To safeguard scans against catastrophic regex backtracking (Regular Expression Denial of Service - ReDoS):

- **Sandboxed Execution**: Custom regex evaluations run in a dedicated, timeout-enforced Node.js VM context (`timeoutMs`, default 100ms per file).
- **Graceful Abortion**: If a regex evaluation exceeds the timeout limit, the pattern is aborted with a clean warning rather than hanging the scan.
- **Input Bounds**: Lines longer than 20,000 characters and files exceeding 512 KB are safely bounded to prevent excessive memory overhead.

### Labeled Findings & Quality Gates

Findings generated from custom rules are clearly labeled across all exporters:

- **Terminal Output**: Prefix labeled as `🚨 [SecureFlow] [Custom Rule: <id>] <message>`
- **SARIF**: Exported with rule identifier `CUSTOM-<id>`, level mapped according to severity, and custom metadata tags
- **Markdown / HTML / CSV**: Labeled with `[Custom Rule: <id>]`
- **Quality Gates**: Custom rule severities are evaluated directly against your `--fail-on` threshold.

---

## 🔄 CI/CD Pipeline Integration

### GitHub Actions Workflow (SARIF & Markdown)

```yaml
name: Security Scan
on: [push, pull_request]

jobs:
  secureflow-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run SecureFlow Scanner (SARIF)
        run: npx secureflow-cli --format sarif -o results.sarif --fail-on high

      - name: Upload SARIF to GitHub Security tab
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif

      - name: Generate PR Markdown Summary
        if: always()
        run: npx secureflow-cli --format markdown -o pr-summary.md
```

### Jenkins Pipeline (JUnit Test Results)

```groovy
pipeline {
    agent any
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        stage('Security Scan') {
            steps {
                sh 'npx secureflow-cli --format junit -o secureflow-junit.xml --fail-on high'
            }
            post {
                always {
                    junit testResults: 'secureflow-junit.xml', allowEmptyResults: true
                }
            }
        }
    }
}
```

### GitLab CI/CD (`.gitlab-ci.yml`)

```yaml
stages:
  - test

secureflow_scan:
  stage: test
  image: node:20
  script:
    - npx secureflow-cli --format junit -o secureflow-junit.xml --fail-on high
  artifacts:
    when: always
    reports:
      junit: secureflow-junit.xml
```

### Azure DevOps Pipeline (`azure-pipelines.yml`)

```yaml
trigger:
  - main

pool:
  vmImage: "ubuntu-latest"

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: "20.x"
    displayName: "Install Node.js"

  - script: |
      npx secureflow-cli --format junit -o $(Build.SourcesDirectory)/test-results.xml --fail-on high
    displayName: "Run SecureFlow Security Scan"

  - task: PublishTestResults@2
    condition: always()
    inputs:
      testResultsFormat: "JUnit"
      testResultsFiles: "**/test-results.xml"
      testRunTitle: "SecureFlow Security Scan"
      failTaskOnFailedTests: true
```

---

## 🎨 Terminal Color Support & NO_COLOR

SecureFlow adheres to modern terminal conventions and the [NO_COLOR specification](https://no-color.org/):

- **Automatic Non-TTY Detection**: When output is piped to another command (e.g. `secureflow | cat`) or redirected to a log file (`secureflow > scan.log`), ANSI color codes are automatically disabled.
- **NO_COLOR Environment Variable**: Setting `NO_COLOR=1` (or any non-empty value) disables ANSI color codes across all formatted outputs.
- **`--no-color` Flag**: Explicitly disable colors in interactive terminal sessions.
- **`--color` Flag**: Force colored output on, even in non-TTY environments (e.g. CI logs supporting ANSI rendering).

```bash
# Disable color via environment variable
NO_COLOR=1 secureflow

# Explicitly disable color via flag
secureflow --no-color

# Force color in CI logs or pipes
secureflow --color | tee audit.log
```

---

## 📄 License

This package is licensed under the [ISC License](https://github.com/GauravKarakoti/SecureFlow/blob/main/LICENSE). Built with ❤️ by the SecureFlow Team.

### Threat-intelligence cache diagnostics and offline recovery

Threat-feed entries use an in-memory/optional Redis cache with separate fresh
and stale deadlines and a SHA-256 payload checksum. The generic cache defaults
to one hour fresh and seven days stale; individual feeds set their own windows
(the local CISA KEV catalog uses 24 hours fresh). Existing callers determine when
to use cached or stale data. Expired data is rejected by a normal read; an
outage caller may explicitly request an expired fallback if that entry is still
retained. A prior normal read may already have evicted it.

An absent cache/local CISA file is an ordinary cold miss and stays quiet.
Malformed JSON, an invalid local catalog structure, and unexpected local file
read errors now produce concise warnings on **stderr**. Cache contents, parser
exception text and Redis connection URLs are not included in these diagnostics.
Scanner JSON on stdout remains available for automation. Existing checksum
warnings and scan/fallback exit-code behavior are unchanged.

Malformed cached JSON is rejected even when expired fallback is requested, and
the invalid in-memory copy is discarded. A malformed Redis value is not deleted
by this diagnostic path: a successful feed refresh must replace it. The local
CISA catalog is never deleted automatically. If a warning persists, check local
file readability and run the repository's existing `npm run threat-feed:sync`
workflow when online, or restore a known-good synchronized catalog and checksum
through your normal offline feed-management process. Keep a backup; do not edit
or bypass the checksum to make a corrupt payload load. No refresh or network
request is triggered merely by printing a diagnostic.

Regression checks cover cold misses, empty/malformed memory and Redis JSON,
local deserialization/schema/read failures, recovery after replacement, exact
fresh/stale/expired TTL boundaries, and existing checksum/outage fallback rules.
