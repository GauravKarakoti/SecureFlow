import { describe, it, expect } from 'vitest';
import { generateSarifReport, formatSarifJson } from './sarif.js';
import { FileScanResult, formatScanResults } from './scanner.js';

describe('SARIF Export Functionality for SecureFlow CLI (#728)', () => {
  const sampleScanResults: FileScanResult[] = [
    {
      path: 'src/config/db.ts',
      violations: [
        {
          line: 15,
          text: 'console.log("DB Password:", process.env.DB_PASSWORD);',
          reason: 'environment variable',
        },
        {
          line: 28,
          text: 'console.warn("API Token:", apiKeyToken);',
          reason: 'secret-named identifier',
        },
      ],
    },
    {
      path: 'src/utils/logger.ts',
      violations: [
        {
          line: 42,
          text: 'console.error("Auth:", customAuthSecret);',
          reason: 'secret-named identifier',
        },
      ],
    },
    {
      path: 'src/components/clean.ts',
      violations: [],
    },
  ];

  describe('generateSarifReport', () => {
    it('should generate valid SARIF v2.1.0 root structure', () => {
      const sarif = generateSarifReport(sampleScanResults);

      expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
      expect(sarif.version).toBe('2.1.0');
      expect(sarif.runs).toHaveLength(1);

      const run = sarif.runs[0];
      expect(run.tool.driver.name).toBe('SecureFlow CLI');
      expect(run.tool.driver.semanticVersion).toBe('0.1.0');
      expect(run.tool.driver.rules.length).toBeGreaterThan(0);
    });

    it('should map violations into SARIF results with correct rules and location metadata', () => {
      const sarif = generateSarifReport(sampleScanResults);
      const run = sarif.runs[0];

      expect(run.results).toHaveLength(3);

      const firstResult = run.results[0];
      expect(firstResult.ruleId).toBe('SECUREFLOW-001');
      expect(firstResult.level).toBe('error');
      expect(firstResult.message.text).toContain('process.env.DB_PASSWORD');

      const location = firstResult.locations[0].physicalLocation;
      expect(location.artifactLocation.uri).toBe('src/config/db.ts');
      expect(location.region.startLine).toBe(15);
      expect(location.region.snippet?.text).toBe(
        'console.log("DB Password:", process.env.DB_PASSWORD);'
      );
    });

    it('should handle custom tool versions in SARIF driver metadata', () => {
      const sarif = generateSarifReport(sampleScanResults, { toolVersion: '1.2.3-beta' });
      expect(sarif.runs[0].tool.driver.semanticVersion).toBe('1.2.3-beta');
    });

    it('should produce valid SARIF structure when no violations are found', () => {
      const cleanResults: FileScanResult[] = [
        { path: 'src/safe.ts', violations: [] },
      ];
      const sarif = generateSarifReport(cleanResults);

      expect(sarif.runs[0].results).toHaveLength(0);
      expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
    });

    it('should handle Windows path backslashes cleanly by converting to forward slashes', () => {
      const windowsResults: FileScanResult[] = [
        {
          path: 'src\\nested\\module\\config.ts',
          violations: [
            {
              line: 10,
              text: 'console.log(process.env.API_KEY)',
              reason: 'environment variable',
            },
          ],
        },
      ];

      const sarif = generateSarifReport(windowsResults);
      const uri = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
      expect(uri).toBe('src/nested/module/config.ts');
    });
  });

  describe('formatSarifJson & formatScanResults', () => {
    it('should return pretty JSON formatted SARIF string', () => {
      const jsonString = formatSarifJson(sampleScanResults);
      expect(jsonString).toContain('"version": "2.1.0"');
      expect(jsonString).toContain('"SecureFlow CLI"');
      expect(() => JSON.parse(jsonString)).not.toThrow();
    });

    it('should output SARIF format via formatScanResults', () => {
      const sarifOutput = formatScanResults(sampleScanResults, 'sarif');
      const parsed = JSON.parse(sarifOutput);
      expect(parsed.$schema).toContain('sarif');
      expect(parsed.runs[0].results.length).toBe(3);
    });

    it('should output JSON format via formatScanResults', () => {
      const jsonOutput = formatScanResults(sampleScanResults, 'json');
      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
    });

    it('should output text summary via formatScanResults', () => {
      const textOutput = formatScanResults(sampleScanResults, 'text');
      expect(textOutput).toContain('🚨 [SecureFlow] Secret logging detected');
      expect(textOutput).toContain('src/config/db.ts:15');
    });
  });
});
