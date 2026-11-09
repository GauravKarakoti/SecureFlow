# SecureFlow Threat Intelligence MCP Server

The SecureFlow CLI includes a **Model Context Protocol (MCP)** server (`cli/src/mcp/index.ts`) exposing bundled advisory examples and caller-provided remediation-history summaries over standard I/O (`stdio`). It does not fetch a live CVE feed or connect to the dashboard database.

IDE agents can retrieve the bundled guidance and inspect reported remediation outcomes. Treat these as context for review, not verification that an advisory is current or that an applied patch resolves a vulnerability.

---

## Architecture Overview

```text
┌──────────────────────────────────────────────┐
│       IDE Agent / AI Assistant               │
│  (Cursor, Claude Desktop, Windsurf, etc.)   │
└──────────────────────┬───────────────────────┘
                       │ JSON-RPC 2.0 (stdio)
                       ▼
┌──────────────────────────────────────────────┐
│           SecureFlow CLI MCP Server          │
│             `secureflow mcp`                 │
├──────────────────────────────────────────────┤
│ 🛡️ ArmorIQ Cryptographic Intent Verification  │
│    - Fail-closed prompt injection filter    │
│    - HMAC-SHA256 execution proof signing    │
├──────────────────────────────────────────────┤
│ 📚 Bundled Threat Intelligence Knowledge Base│
│    - CVE lookups & CWE categorization        │
│    - Actionable remediation code patterns   │
└──────────────────────────────────────────────┘
```

The server operates locally via `stdio` using `@modelcontextprotocol/sdk`, requiring no external ports or network ingress.

---

## Available MCP Tools

The server registers tools exposed via `ListToolsRequestSchema`:

### 1. `scan_content`

Scan one caller-supplied source file without opening files, executing code or making
network requests. The existing secret-logging detector always runs. An additional
heuristic checks directly quoted ASCII tokens in console calls using the CLI's
`hasHighEntropy` function and benign-value whitelist.

| Argument         | Default    | Validation                                                                                                               |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `content`        | required   | String, at most 524,288 UTF-8 bytes                                                                                      |
| `path`           | `input.ts` | Relative report label, at most 256 characters; ASCII letters, digits, `_`, `-`, `.`, `/`; no empty, `.` or `..` segments |
| `minEntropy`     | `2.8`      | Finite number from 0 to 8 bits per character                                                                             |
| `minTokenLength` | `16`       | Integer from 8 to 256                                                                                                    |
| `format`         | `json`     | `json`, `text`, `sarif`, `csv`, `html`, `markdown`, `md`                                                                 |
| `intentToken`    | omitted    | Optional string; existing intent verification applies                                                                    |

Unknown keys, null values and invalid argument types return a tool error with
`code: "INVALID_ARGUMENTS"`. The existing ArmorIQ gate runs first and can reject
source containing its blocked phrases. A configured proof-signing key is required.

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "scan_content",
    "arguments": {
      "content": "console.log(password);",
      "path": "src/example.ts",
      "minEntropy": 3.5,
      "minTokenLength": 20,
      "format": "sarif"
    }
  }
}
```

The result appears identically as JSON text and `structuredContent`: `source`
(`caller_provided`), `format`, effective thresholds, `violationCount`, `results`
(the CLI file-scan shape, including any skip reason), and `report` (a string).
For SARIF, parse `report` to obtain the existing SARIF 2.1.0 document. Other report
formats reuse the CLI exporters. Source snippets in both `results` and `report`
are replaced with `[source redacted]`; report labels and finding locations remain.
The input still reaches the local server and client history: never submit real
credentials merely to test detection.

Sensitivity only affects literal detection; it cannot disable identifier-based
secret logging checks. Literal checks cover 8–256-character directly quoted
ASCII alphanumeric/base64-like tokens, not arbitrary JavaScript evaluation,
concatenation, escaped strings, or resolved variable values. High entropy is a
heuristic, not proof of a secret. CLI binary/type exclusions and its benign-value
whitelist still apply; one finding per console-call line is returned.

### 2. `query_threat_intelligence`

Searches the threat intelligence knowledge base for security advisories matching keywords, vulnerability classes, or CVE IDs.

- **Parameters**:
  - `query` (`string`, **required**): Search keyword, vulnerability type, or CVE identifier (e.g., `"SQL injection"`, `"SSRF"`, `"CVE-2023-3409"`, `"secret logging"`).
  - `intentToken` (`string`, _optional_): Cryptographic intent token declaring an approved plan for ArmorIQ verification.
- **Returns**: A JSON array of matching `ThreatIntelligenceEntry` objects containing `id`, `category`, `description`, `severity`, `cve`, and `remediationGuidance`. If no direct match is found, representative defensive advisories are returned.

### 3. `lookup_cve`

Retrieves detailed vulnerability information, severity rating, and concrete remediation instructions for an exact CVE or CWE identifier.

- **Parameters**:
  - `cveId` (`string`, **required**): The CVE or CWE identifier (e.g., `"CVE-2023-3409"`, `"CVE-2023-28154"`, `"CWE-79"`, `"CWE-94"`). Case-insensitive.
  - `intentToken` (`string`, _optional_): Cryptographic intent token declaring an approved plan for ArmorIQ verification.
- **Returns**: A JSON object with the full threat advisory and remediation guidance, or an error payload with defensive programming recommendations if the identifier is not in the local database.

---

### 4. `get_remediation_context`

Summarizes a caller-supplied snapshot of remediation attempts. Each history row
represents one attempt's latest status, not multiple updates of the same attempt.
The standalone CLI has no authenticated production-data connection. Supply only
non-sensitive advisory IDs and outcomes; do not include source code or secrets.

The input JSON Schema is defined in
[`index.ts`](../cli/src/mcp/index.ts) and returned by
`tools/list`:

```json
{
  "type": "object",
  "properties": {
    "history": {
      "type": "array",
      "maxItems": 1000,
      "items": {
        "type": "object",
        "properties": {
          "advisoryId": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9-]{0,63}$" },
          "status": { "type": "string", "enum": ["APPLIED", "FAILED", "PENDING", "GENERATED"] }
        },
        "required": ["advisoryId", "status"],
        "additionalProperties": false
      }
    },
    "advisoryId": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9-]{0,63}$" },
    "intentToken": { "type": "string" }
  },
  "required": ["history"],
  "additionalProperties": false
}
```

`advisoryId` filters history case-insensitively. The result includes
`source: "caller_provided"`, the matched `sampleSize`, all four status counts,
`completed` (`APPLIED + FAILED`), and `applicationSuccessRate` as a fraction in
`[0, 1]`. That rate is `null` when no matching attempt is completed. Pending and
generated patches are counted but excluded from the denominator. Application
success is a reported operational outcome, not proof of vulnerability resolution.

### 5. `export_sarif`

Exports caller-supplied file scan findings into standardized OASIS SARIF v2.1.0 format, fully validated for GitHub Advanced Security, GitLab Security Dashboards, and automated CI/CD pipeline ingestion.

- **Parameters**:
  - `results` (`array`, **required**): Array of scan result objects, each containing:
    - `path` (`string`, **required**): File path where violations occurred.
    - `violations` (`array`, **required**): List of violation objects with `reason` (`string`), `line` (`integer >= 1`), `text` (`string`), and optional `ruleId`, `column`, `severity`.
  - `toolVersion` (`string`, _optional_): Custom semantic tool version string (defaults to `"0.1.0"`).
  - `intentToken` (`string`, _optional_): Cryptographic intent token declaring an approved plan for ArmorIQ verification.
- **Returns**: A valid OASIS SARIF v2.1.0 JSON document structure with tool driver metadata, rule definitions, and mapped results.

Example tool call:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "export_sarif",
    "arguments": {
      "toolVersion": "1.0.0",
      "results": [
        {
          "path": "src/api/auth.ts",
          "violations": [
            {
              "ruleId": "SECUREFLOW-001",
              "reason": "environment variable",
              "line: 42,
              "text": "console.log(process.env.SECRET_KEY)"
            }
          ]
        }
      ]
    }
  }
}
```

### 6. `generate_remediation_patch` / `generate-remediation-patch`

Triggers AI remediation patch generation for a specific security finding via the SecureFlow platform API (`POST /api/findings/[id]/remediate`). Both snake_case (`generate_remediation_patch`) and kebab-case (`generate-remediation-patch`) are supported.

- **Parameters**:
  - `findingId` (`string`, **required**): The ID of the finding to remediate.
  - `baseUrl` (`string`, _optional_): Custom base URL for the SecureFlow platform (defaults to production endpoint `https://secure-flow-six.vercel.app`).
  - `authToken` (`string`, _optional_): Authentication bearer token if required by the target environment.
  - `timeoutMs` (`integer`, _optional_): Timeout in milliseconds for patch generation (defaults to 15,000ms).
  - `intentToken` (`string`, _optional_): Cryptographic intent token declaring an approved plan for ArmorIQ verification.
- **Returns**: A JSON payload containing remediation results:
  - `success`: Boolean indicating if patch generation completed.
  - `patch`: Object containing `id`, `findingId`, `patchDiff` (unified diff format), and `status` (`"GENERATED"`).
  - `explanation`: AI explanation of the applied security fixes.
  - On failure or rate limit: returns error code, explanation, and `retryable: true` flag.

Example tool call:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "generate-remediation-patch",
    "arguments": {
      "findingId": "finding-cwe-89-sqli",
      "baseUrl": "https://secure-flow-six.vercel.app"
    }
  }
}
```

### 7. `web3_security_explanations` / `web3-security-explanations`

Generates specialized AI security explanations and remediation recommendations for Web3 smart contracts and Zero-Knowledge (ZK) circuits (`POST /api/explain/web3`). Understands Solidity / EVM reentrancy and delegatecall risks, Rust / Soroban / Solana CPI and ownership hazards, and ZK Circom / Aleo Leo under-constrained signals and soundness bugs. If the remote endpoint is unreachable or in offline mode, automatically executes an internal heuristic analyzer for graceful degradation. Both snake_case and kebab-case tool names are registered and callable.

- **Parameters**:
  - `findingType` (`string`, **required**): Type of Web3/ZK vulnerability (e.g., `"reentrancy"`, `"under-constrained-signal"`, `"soroban-auth-bypass"`, `"unsafe-arithmetic"`).
  - `severity` (`string`, **required**): Severity level: `"LOW"`, `"MEDIUM"`, `"HIGH"`, or `"CRITICAL"`.
  - `description` (`string`, **required**): Detailed explanation of the vulnerability context or detected flaw.
  - `fileLocation` (`string`, **required**): Path to the smart contract or circuit file (e.g., `"contracts/Vault.sol"`, `"circuits/withdraw.circom"`, `"src/lib.rs"`).
  - `codeSnippet` (`string`, **required**): The vulnerable code or circuit definition snippet.
  - `baseUrl` (`string`, _optional_): Custom base URL for the SecureFlow platform (defaults to production endpoint `https://secure-flow-six.vercel.app`).
  - `authToken` (`string`, _optional_): Authentication bearer token if required.
  - `intentToken` (`string`, _optional_): Cryptographic intent token declaring an approved plan for ArmorIQ verification.
- **Returns**: A JSON payload containing Web3 explanation details:
  - `ecosystem`: Detected ecosystem (`"solidity"`, `"rust-soroban"`, `"zk-circuit"`, or `"generic-web3"`).
  - `explanation`: Comprehensive technical explanation of the vulnerability and attack vector.
  - `remediationSuggestions`: Actionable mitigation steps (e.g., CEI pattern, ReentrancyGuard, non-malleability range checks).

Example tool call:

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "web3-security-explanations",
    "arguments": {
      "findingType": "reentrancy",
      "severity": "CRITICAL",
      "description": "State variable updated after low-level external call",
      "fileLocation": "contracts/Vault.sol",
      "codeSnippet": "msg.sender.call{value: balance}(''); balances[msg.sender] = 0;"
    }
  }
}
```

Example response:

```json
{
  "ecosystem": "solidity",
  "explanation": "[SecureFlow Web3] Detected potential CRITICAL vulnerability (reentrancy) in contracts/Vault.sol. Ensure state changes precede external calls and access controls are strictly validated.",
  "remediationSuggestions": [
    "Follow Checks-Effects-Interactions (CEI) pattern to prevent reentrancy.",
    "Employ OpenZeppelin or equivalent audited contracts for access control and math validation.",
    "Ensure all circuit signals are strictly constrained with proper range checks."
  ]
}
```

## JSON-RPC contract

This is a stdio service, not an HTTP endpoint. The SDK handles newline-delimited
JSON-RPC 2.0 frames on stdin/stdout; diagnostics go to stderr. Follow the
[MCP tools protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
After the `initialize` handshake shown below, send
`{"jsonrpc":"2.0","method":"notifications/initialized"}` before tool requests.

Discover the exact advertised schemas:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

The response is `{ "jsonrpc": "2.0", "id": 2, "result": { "tools": [...] } }`.
Each entry has `name`, `description` and `inputSchema`. Existing advisory calls
keep their original schemas and text-encoded JSON results:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "lookup_cve", "arguments": { "cveId": "CWE-79" } }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": { "name": "query_threat_intelligence", "arguments": { "query": "SQL injection" } }
}
```

Request reported history context:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "get_remediation_context",
    "arguments": {
      "advisoryId": "cwe-79",
      "history": [
        { "advisoryId": "CWE-79", "status": "APPLIED" },
        { "advisoryId": "CWE-79", "status": "FAILED" },
        { "advisoryId": "CWE-79", "status": "PENDING" }
      ]
    }
  }
}
```

The new tool returns the same object in `structuredContent` and as JSON in
`content[0].text` (with `type: "text"`). Parse the latter as JSON to obtain
`sampleSize: 3`, `completed: 2`, `applicationSuccessRate: 0.5`, and
`counts: { "APPLIED": 1, "FAILED": 1, "PENDING": 1, "GENERATED": 0 }`.
Malformed context returns `result.isError: true` with text JSON containing
`code: "INVALID_ARGUMENTS"`. Intent-gate failures use
`ARMORIQ_INTENT_VERIFICATION_FAILED` and run before context validation.
Unknown tool names produce a JSON-RPC error rather than a successful tool result.

Run the actual client/server transport tests and compile the CLI:

```bash
npm ci --legacy-peer-deps
npm run cli:build
npm run cli:test
```

## ArmorIQ Cryptographic Intent Verification

All MCP tool invocations are gated by the `verifyDeclaredIntent` boundary filter before execution to prevent prompt injection and unauthorized actions:

1. **Adversarial Prompt Injection Defense (CWE-94)**:
   - Evaluates arguments against known adversarial patterns, such as system overrides, jailbreak phrases (`"ignore previous instructions"`, `"system override"`), and attempts to exfiltrate private tokens or credentials (`"exfiltrate secret"`, `"leak intent token"`, `ARMORIQ_API_KEY`).
   - If detected, execution halts **fail-closed** and returns an error:
     ```json
     {
       "error": "Action blocked by ArmorIQ: Adversarial prompt injection (CWE-94) detected",
       "code": "ARMORIQ_INTENT_VERIFICATION_FAILED",
       "enforcement": "FAIL_CLOSED"
     }
     ```

2. **Intent checks and proof signing**:
   - The existing gate checks argument text with regular expressions, and its token helper checks length/tampering markers. These checks are not cryptographic verification of caller identity or a comprehensive prompt-injection defense.
   - The current argument filter also matches the literal `intentToken` key. Supplying that optional field in an MCP call therefore fails closed; omit it for ordinary local calls. This extension preserves the existing gate.
   - The helper computes an HMAC-SHA256 proof using `ARMORIQ_PROOF_SIGNING_KEY`; the MCP handler does not expose that internal proof in tool responses. Missing signing configuration fails closed.

---

## Environment Variables

| Variable                    | Default         | Purpose                                                                  |
| :-------------------------- | :-------------- | :----------------------------------------------------------------------- |
| `ARMORIQ_PROOF_SIGNING_KEY` | none (required) | Secret key used to sign execution proofs and verify intent authenticity. |

---

## IDE & Client Configuration

You can launch the MCP server globally via `npx`, through a global `npm install`, or directly from a local repository checkout.

### Option A: Cursor

Cursor supports MCP servers configured via workspace `.cursor/mcp.json` or user-level settings.

#### Workspace Configuration (`.cursor/mcp.json`)

Create or update `.cursor/mcp.json` in your workspace root:

```json
{
  "mcpServers": {
    "secureflow": {
      "command": "npx",
      "args": ["-y", "secureflow-cli", "mcp"],
      "env": {
        "ARMORIQ_PROOF_SIGNING_KEY": "your-custom-intent-signing-key"
      }
    }
  }
}
```

#### Settings UI:

1. Open **Cursor Settings** (`Cmd + ,` or `Ctrl + ,`).
2. Navigate to **Features** -> **MCP Servers**.
3. Click **Add New MCP Server**.
4. Set **Name** to `secureflow`.
5. Set **Type** to `stdio`.
6. Set **Command** to:
   ```text
   npx -y secureflow-cli mcp
   ```

---

### Option B: Claude Desktop

Claude Desktop configures MCP servers in `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the `secureflow` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "secureflow": {
      "command": "npx",
      "args": ["-y", "secureflow-cli", "mcp"],
      "env": {
        "ARMORIQ_PROOF_SIGNING_KEY": "your-custom-intent-signing-key"
      }
    }
  }
}
```

---

### Option C: Windsurf

Configure Windsurf via `~/.codeium/windsurf/mcp_config.json`:

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

---

### Option D: Local Development / Monorepo Build

If you are developing inside the SecureFlow repository or testing local modifications:

1. Build the CLI package:

   ```bash
   cd cli
   npm run build
   ```

2. Point your IDE configuration to the compiled entrypoint:
   ```json
   {
     "mcpServers": {
       "secureflow-local": {
         "command": "node",
         "args": ["/absolute/path/to/SecureFlow/cli/dist/index.js", "mcp"]
       }
     }
   }
   ```

---

## Verifying the Server Manually

You can test that the MCP server starts correctly by running it from your terminal:

```bash
npx -y secureflow-cli mcp
```

The server writes diagnostics to `stderr` and listens for JSON-RPC messages on `stdin`:

```text
SecureFlow Threat Intelligence MCP Server running via stdio
```

You can send a test JSON-RPC initialize request via `stdin`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "test-client", "version": "1.0.0" }
  }
}
```

---

## Example Agent Prompts

Once configured, your AI coding assistant can leverage the MCP server autonomously:

- _"Check the threat intelligence database for CVE-2023-3409 and give me the recommended remediation for our database queries."_
- _"We are building an outbound webhook caller. Query the threat intelligence server for SSRF vulnerabilities and best practices."_
- _"Look up CWE-79 and check if our template escaping implementation matches recommended guidelines."_
