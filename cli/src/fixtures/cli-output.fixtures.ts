/**
 * Deterministic Test Fixtures for SecureFlow CLI Terminal UI & Output Formatting
 *
 * Provides static, zero-randomness fixtures across:
 * - Zero findings (clean scan)
 * - Single finding (isolated critical/high)
 * - Many findings spanning all severities (CRITICAL, HIGH, MEDIUM, LOW, and INFO)
 * - Long file paths and long messages testing layout bounds and truncation
 */

import type { FileScanResult } from "../scanner.js";
import type { AiFinding } from "../contracts/index.js";
import type { TableRow } from "../lib/tui.js";

export interface ScanOutputFixture {
  name: string;
  results: FileScanResult[];
  aiFindings: AiFinding[];
  expectedRows: TableRow[];
}

/**
 * Fixture representing zero security findings or secret logging detections.
 */
export const zeroFindingsFixture: ScanOutputFixture = {
  name: "zero findings (empty results)",
  results: [],
  aiFindings: [],
  expectedRows: [],
};

/**
 * Fixture representing scanned files that contain no violations.
 */
export const cleanFilesFixture: ScanOutputFixture = {
  name: "clean staged files with zero violations",
  results: [
    {
      path: "src/utils/calculator.ts",
      violations: [],
    },
    {
      path: "src/helpers/formatters.ts",
      violations: [],
    },
  ],
  aiFindings: [],
  expectedRows: [],
};

/**
 * Fixture representing a single critical finding from static file analysis.
 */
export const singleCriticalFindingFixture: ScanOutputFixture = {
  name: "single critical secret logging finding",
  results: [
    {
      path: "src/auth/token-service.ts",
      violations: [
        {
          line: 42,
          text: "console.log('User session token:', sessionAuthToken);",
          reason: "Sensitive authentication token printed to console",
          severity: "CRITICAL",
        },
      ],
    },
  ],
  aiFindings: [],
  expectedRows: [
    {
      severity: "CRITICAL",
      location: "src/auth/token-service.ts:42",
      rule: "Secret Logging",
      details: "Sensitive authentication token printed to co",
    },
  ],
};

/**
 * Fixture representing a single AI finding with HIGH severity.
 */
export const singleAiFindingFixture: ScanOutputFixture = {
  name: "single high AI finding",
  results: [],
  aiFindings: [
    {
      type: "SQL_INJECTION",
      severity: "HIGH",
      fileLocation: "src/database/repositories/user-repository.ts",
      lineStart: 88,
      codeSnippet: "db.query(`SELECT * FROM users WHERE email = '${userEmail}'`);",
      description: "Unsanitized user-supplied input concatenated into SQL query",
    },
  ],
  expectedRows: [
    {
      severity: "HIGH",
      location: "src/database/repositories/user-repository.ts:88",
      rule: "SQL_INJECTION",
      details: "Unsanitized user-supplied input concatenated",
    },
  ],
};

/**
 * Fixture representing many findings across all severities:
 * CRITICAL, HIGH, MEDIUM, LOW, and INFO/fallback badges.
 */
export const manyFindingsAllSeveritiesFixture: ScanOutputFixture = {
  name: "many findings spanning all severities",
  results: [
    {
      path: "src/auth/jwt-signer.ts",
      violations: [
        {
          line: 24,
          text: "console.log('Private key:', privateKeyPem);",
          reason: "Private signing key leaked in logs",
          severity: "CRITICAL",
        },
        {
          line: 77,
          text: "console.warn('Hashed password:', hash);",
          reason: "Password hash emitted in warning log",
          severity: "HIGH",
        },
      ],
    },
    {
      path: "src/config/aws-credentials.ts",
      violations: [
        {
          line: 15,
          text: "console.debug('Access key id:', accessKeyId);",
          reason: "Cloud provider identifier in debug log",
          severity: "MEDIUM",
        },
      ],
    },
    {
      path: "src/telemetry/tracker.ts",
      violations: [
        {
          line: 102,
          text: "console.info('Internal node IP:', internalIp);",
          reason: "Internal network topology disclosure",
          severity: "LOW",
        },
      ],
    },
  ],
  aiFindings: [
    {
      type: "HARDCODED_SECRET",
      severity: "CRITICAL",
      fileLocation: "deploy/helm/values-production.yaml",
      lineStart: 54,
      codeSnippet: "db_password: SuperSecretPassword123!",
      description: "Plaintext database password in Helm chart configuration",
    },
    {
      type: "COMMAND_INJECTION",
      severity: "HIGH",
      fileLocation: "src/services/command-runner.ts",
      lineStart: 135,
      codeSnippet: "child_process.exec(`ping -c 4 ${targetHost}`);",
      description: "Arbitrary command execution via unsanitized host parameter",
    },
    {
      type: "INSECURE_RANDOM",
      severity: "MEDIUM",
      fileLocation: "src/crypto/nonce-generator.ts",
      lineStart: 31,
      codeSnippet: "const nonce = Math.random().toString(36);",
      description: "Cryptographically insecure PRNG used for nonce generation",
    },
    {
      type: "EXCESSIVE_PERMISSIONS",
      severity: "LOW",
      fileLocation: "Dockerfile",
      lineStart: 18,
      codeSnippet: "USER root",
      description: "Container runs as superuser root without dropped privileges",
    },
    {
      type: "DEPRECATED_CIPHER",
      // Cast to test default / fallback severity badge formatting ("INFO")
      severity: "INFO" as unknown as "LOW",
      fileLocation: "src/crypto/legacy-cipher.ts",
      lineStart: 9,
      codeSnippet: "crypto.createCipher('des-ecb', key);",
      description: "Deprecated and insecure single-DES ECB encryption cipher",
    },
  ],
  expectedRows: [
    {
      severity: "CRITICAL",
      location: "src/auth/jwt-signer.ts:24",
      rule: "Secret Logging",
      details: "Private signing key leaked in logs",
    },
    {
      severity: "HIGH",
      location: "src/auth/jwt-signer.ts:77",
      rule: "Secret Logging",
      details: "Password hash emitted in warning log",
    },
    {
      severity: "MEDIUM",
      location: "src/config/aws-credentials.ts:15",
      rule: "Secret Logging",
      details: "Cloud provider identifier in debug log",
    },
    {
      severity: "LOW",
      location: "src/telemetry/tracker.ts:102",
      rule: "Secret Logging",
      details: "Internal network topology disclosure",
    },
    {
      severity: "CRITICAL",
      location: "deploy/helm/values-production.yaml:54",
      rule: "HARDCODED_SECRET",
      details: "Plaintext database password in Helm chart con",
    },
    {
      severity: "HIGH",
      location: "src/services/command-runner.ts:135",
      rule: "COMMAND_INJECTION",
      details: "Arbitrary command execution via unsanitized h",
    },
    {
      severity: "MEDIUM",
      location: "src/crypto/nonce-generator.ts:31",
      rule: "INSECURE_RANDOM",
      details: "Cryptographically insecure PRNG used for nonc",
    },
    {
      severity: "LOW",
      location: "Dockerfile:18",
      rule: "EXCESSIVE_PERMISSIONS",
      details: "Container runs as superuser root without drop",
    },
    {
      severity: "INFO",
      location: "src/crypto/legacy-cipher.ts:9",
      rule: "DEPRECATED_CIPHER",
      details: "Deprecated and insecure single-DES ECB encryp",
    },
  ],
};

/**
 * Fixture representing deeply nested long file paths and long message descriptions.
 * Tests table width expansion, truncation behavior, and alignment stability.
 */
export const longPathsAndMessagesFixture: ScanOutputFixture = {
  name: "long file paths and long message descriptions",
  results: [
    {
      path: "packages/enterprise-cloud-infrastructure/src/adapters/secret-store/vault/providers/azure-key-vault-managed-identity/v2/credentials-provider-manager-service-impl.ts",
      violations: [
        {
          line: 1849,
          text: "console.log('Plaintext master symmetric encryption key:', keyMaterial);",
          reason:
            "Detected plaintext enterprise symmetric encryption master key passed to production auditing logger with verbose stack trace output",
          severity: "CRITICAL",
        },
      ],
    },
  ],
  aiFindings: [
    {
      type: "DISTRIBUTED_TRANSACTION_REENTRANCY_VULNERABILITY",
      severity: "HIGH",
      fileLocation:
        "packages/contracts/smart-contracts/protocols/liquidity-pool/v3/core/isolated-vault-collateral-asset-deposit-handler-impl.sol",
      lineStart: 2490,
      lineEnd: 2515,
      codeSnippet: "assetVault.withdrawCollateral(recipientAddress, requestedAmount);",
      description:
        "Critical smart contract reentrancy vulnerability allowing malicious reentrant withdrawals before internal balance accounting state update in liquidation fallback handler",
    },
  ],
  expectedRows: [
    {
      severity: "CRITICAL",
      location:
        "packages/enterprise-cloud-infrastructure/src/adapters/secret-store/vault/providers/azure-key-vault-managed-identity/v2/credentials-provider-manager-service-impl.ts:1849",
      rule: "Secret Logging",
      details:
        "Detected plaintext enterprise symmetric encryption master key passed to production auditing logger with verbose stack trace output",
    },
    {
      severity: "HIGH",
      location:
        "packages/contracts/smart-contracts/protocols/liquidity-pool/v3/core/isolated-vault-collateral-asset-deposit-handler-impl.sol:2490",
      rule: "DISTRIBUTED_TRANSACTION_REENTRANCY_VULNERABILITY",
      details: "Critical smart contract reentrancy vulnerability",
    },
  ],
};
