import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  formatTuiScanSummary,
  renderWarningTable,
  setColorEnabled,
  stripAnsi,
  type TableRow,
} from "./tui.js";
import {
  zeroFindingsFixture,
  cleanFilesFixture,
  singleCriticalFindingFixture,
  singleAiFindingFixture,
  manyFindingsAllSeveritiesFixture,
  longPathsAndMessagesFixture,
} from "../fixtures/cli-output.fixtures.js";

/**
 * Snapshot Test Suite for SecureFlow CLI Terminal UI & Output Formatting
 *
 * Catches accidental layout, border, badge, and summary banner regressions.
 * Enforces zero-color plain-text determinism across test runners and CI.
 */
describe("CLI Output Formatting Snapshot Tests", () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  beforeAll(() => {
    // Strictly disable ANSI colors and styling for deterministic snapshots
    setColorEnabled(false);
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
  });

  afterAll(() => {
    setColorEnabled(null);
    if (originalNoColor !== undefined) {
      process.env.NO_COLOR = originalNoColor;
    } else {
      delete process.env.NO_COLOR;
    }
    if (originalForceColor !== undefined) {
      process.env.FORCE_COLOR = originalForceColor;
    } else {
      delete process.env.FORCE_COLOR;
    }
  });

  describe("formatTuiScanSummary snapshots (color disabled)", () => {
    it("matches snapshot for zero findings (empty results)", () => {
      const output = formatTuiScanSummary(
        zeroFindingsFixture.results,
        zeroFindingsFixture.aiFindings,
      );

      // Verify ANSI code suppression
      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for clean staged files (no violations)", () => {
      const output = formatTuiScanSummary(cleanFilesFixture.results, cleanFilesFixture.aiFindings);

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for a single critical finding", () => {
      const output = formatTuiScanSummary(
        singleCriticalFindingFixture.results,
        singleCriticalFindingFixture.aiFindings,
      );

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for a single AI finding", () => {
      const output = formatTuiScanSummary(
        singleAiFindingFixture.results,
        singleAiFindingFixture.aiFindings,
      );

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for many findings spanning all severities", () => {
      const output = formatTuiScanSummary(
        manyFindingsAllSeveritiesFixture.results,
        manyFindingsAllSeveritiesFixture.aiFindings,
      );

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for long file paths and long message descriptions", () => {
      const output = formatTuiScanSummary(
        longPathsAndMessagesFixture.results,
        longPathsAndMessagesFixture.aiFindings,
      );

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });
  });

  describe("renderWarningTable snapshots (color disabled)", () => {
    it("matches snapshot for zero rows", () => {
      const output = renderWarningTable([]);
      expect(output).toBe("");
      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for a single finding table row", () => {
      const rows: TableRow[] = [
        {
          severity: "CRITICAL",
          location: "src/auth/token-service.ts:42",
          rule: "Secret Logging",
          details: "Sensitive authentication token printed to console",
        },
      ];

      const output = renderWarningTable(rows);

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for many table rows spanning all severities", () => {
      const rows: TableRow[] = [
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
          severity: "INFO",
          location: "src/crypto/legacy-cipher.ts:9",
          rule: "DEPRECATED_CIPHER",
          details: "Deprecated and insecure single-DES ECB encryption cipher",
        },
      ];

      const output = renderWarningTable(rows);

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });

    it("matches snapshot for table with very long file paths and messages", () => {
      const rows: TableRow[] = [
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
          details:
            "Critical smart contract reentrancy vulnerability allowing malicious reentrant withdrawals",
        },
      ];

      const output = renderWarningTable(rows);

      expect(output).not.toMatch(/\x1b\[/);
      expect(stripAnsi(output)).toBe(output);

      expect(output).toMatchSnapshot();
    });
  });

  describe("Snapshot stability and determinism enforcement", () => {
    it("renders identically across repeated invocations without dynamic variation", () => {
      const renderA = formatTuiScanSummary(
        manyFindingsAllSeveritiesFixture.results,
        manyFindingsAllSeveritiesFixture.aiFindings,
      );
      const renderB = formatTuiScanSummary(
        manyFindingsAllSeveritiesFixture.results,
        manyFindingsAllSeveritiesFixture.aiFindings,
      );

      expect(renderA).toBe(renderB);
      expect(renderA).not.toMatch(/\d{4}-\d{2}-\d{2}/); // No ISO dates
      expect(renderA).not.toMatch(/\d{1,2}:\d{2}:\d{2}/); // No timestamps
    });

    it("fails snapshot expectation when formatting structure changes", () => {
      const standardOutput = renderWarningTable([
        {
          severity: "CRITICAL",
          location: "src/a.ts:1",
          rule: "Rule",
          details: "Details",
        },
      ]);

      // Mutated output simulating an accidental regression in borders or headers
      const regressedOutput = standardOutput.replace(/┌/g, "+").replace(/SEVERITY/g, "SEV");

      expect(regressedOutput).not.toBe(standardOutput);
    });
  });
});
