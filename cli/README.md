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
- [🔄 CI/CD Pipeline Integration](#-cicd-pipeline-integration)
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
  secureflow mcp [options]
  secureflow sbom <file> [options]
  secureflow explain --web3 [options]

Commands:
  mcp                    Start the Threat Intelligence Model Context Protocol (MCP) server over stdio
  sbom <file>            Scan software bill of materials (package.json, requirements.txt) for vulnerabilities
  explain --web3         Generate AI security analysis and remediation for Web3 / Smart Contract findings
```

### Options & Flags

| Flag                   | Shorthand | Default             | Description                                                                                        |
| :--------------------- | :-------- | :------------------ | :------------------------------------------------------------------------------------------------- |
| `--fail-on <level>`    |           | `medium`            | Exit with error code `1` if findings meet or exceed severity (`low`, `medium`, `high`, `critical`) |
| `--format <format>`    |           | `text`              | Output report format: `text`, `json`, `sarif`, `csv`, `html`, `markdown`                           |
| `--output <path>`      | `-o`      | `stdout`            | Write report to the specified file path                                                            |
| `--poll`               |           | `false`             | Poll SBOM scan status until background worker processing completes                                 |
| `--file <path>`        |           |                     | Target file for smart contract analysis with `explain --web3`                                      |
| `--finding-type <id>`  |           |                     | Vulnerability type (e.g. Reentrancy, Overflow) for `explain --web3`                                |
| `--voice`              | `-v`      | `false`             | Play an audio debrief of findings in your terminal upon completion                                 |
| `--local`              |           | `false`             | Skip cloud AI upload and run fully local pattern analysis                                          |
| `--local-model <tag>`  |           | `llama3`            | Specify local model tag when using local AI providers                                              |
| `--ignore-file <path>` |           | `.secureflowignore` | Custom path to ignore configuration file                                                           |
| `--dry-run`            |           | `false`             | Simulate scan execution without writing output files                                               |
| `--verbose`            |           | `false`             | Enable verbose diagnostic logging                                                                  |
| `--help`               | `-h`      |                     | Display CLI usage instructions and exit                                                            |

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

Control the sensitivity of the pre-commit gate:

```bash
# Block only on high and critical findings (standard CI recommendation)
secureflow --fail-on high

# Strict zero-tolerance gate (blocks on any finding, including low)
secureflow --fail-on low

# Allow commits while logging warnings
secureflow --fail-on none
```

---

### Multi-Format Reports (`--format`)

- **Text (`text`)**: Clean, ANSI-colored terminal overview with source code context snippets.
- **SARIF (`sarif`)**: Industry-standard OASIS SARIF 2.1.0 format, ready for direct upload to GitHub Security tab.
- **HTML (`html`)**: Self-contained, responsive HTML report suitable for sharing and compliance reviews.
- **CSV (`csv`)**: Formatted tabular output hardened against spreadsheet formula injection (CWE-1236).
- **JSON (`json`)**: Machine-readable JSON object representing findings and metadata.
- **Markdown (`markdown` / `md`)**: GitHub-Flavored Markdown table with sanitized code fences.

```bash
secureflow --format html -o security-report.html
secureflow --format sarif -o results.sarif
secureflow --format markdown -o findings.md
```

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

For hardware requirements, VRAM sizing, and fallback configuration, see the [Local Model & VRAM Guide](../docs/local-inference.md).

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

| Tool                        | Parameters                              | Description                                                                                 |
| :-------------------------- | :-------------------------------------- | :------------------------------------------------------------------------------------------ |
| `query_threat_intelligence` | `query: string`, `intentToken?: string` | Search CVE and threat intelligence databases for vulnerabilities and remediation guidance.  |
| `lookup_cve`                | `cveId: string`, `intentToken?: string` | Look up detailed advisories, severity scores, and fix patterns for a CVE or CWE identifier. |

_All MCP tool calls are gated behind ArmorIQ cryptographic intent verification to enforce zero-trust boundary compliance and mitigate Prompt Injection (CWE-94)._

For comprehensive IDE configuration steps, intent signing keys, and manual testing instructions, see the dedicated [Threat Intelligence MCP Server Guide](../docs/mcp-server.md).

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

## 🔄 CI/CD Pipeline Integration

### GitHub Actions Workflow

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

      - name: Run SecureFlow Scanner
        run: npx secureflow-cli --format sarif -o results.sarif --fail-on high

      - name: Upload SARIF to GitHub Security tab
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
```

---

## 📄 License

This package is licensed under the [ISC License](https://github.com/GauravKarakoti/SecureFlow/blob/main/LICENSE). Built with ❤️ by the SecureFlow Team.
