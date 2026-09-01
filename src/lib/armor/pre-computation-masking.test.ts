import { describe, it, expect } from 'vitest';
import {
  maskIngressFileContent,
  maskKnownSecretFormats,
  maskHighEntropyTokens,
  auditSecretMasking,
  REDACTION_PLACEHOLDER,
} from './secret-masking';
import {
  getEnterprisePrivacyHeaders,
  isLocalEndpoint,
  EgressSecurityAuditor,
} from './zero-retention-config';
import { ArmorIQScanner } from './scanner';

describe('Pre-Computation Secret Masking & Scanning Ingress Filters (#617)', () => {
  describe('Ingress Secret Obfuscation & Masking', () => {
    it('should obfuscate AWS secret access keys prior to LLM transmission', () => {
      const inputDiff = `
+const awsKey = "AKIAIOSFODNN7EXAMPLE";
+const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      `;
      const masked = maskIngressFileContent(inputDiff);
      expect(masked).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should obfuscate GitHub personal access tokens in raw diff lines', () => {
      const inputDiff = `
+const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      `;
      const masked = maskIngressFileContent(inputDiff);
      expect(masked).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should obfuscate OpenAI and Anthropic API keys', () => {
      const openaiKey = 'sk-proj-1234567890123456789012345678901234567890';
      const anthropicKey = 'sk-ant-api03-12345678901234567890123456789012';

      const input = `
+const openAiClient = new OpenAI({ apiKey: "${openaiKey}" });
+const anthropicClient = new Anthropic({ apiKey: "${anthropicKey}" });
      `;

      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain(openaiKey);
      expect(masked).not.toContain(anthropicKey);
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should redact internal IPv4 addresses to prevent infrastructure leak', () => {
      const input = `
+const INTERNAL_DB_HOST = "10.0.4.15";
+const REDIS_HOST = "192.168.1.100";
+const STAGING_HOST = "172.16.0.5";
      `;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain('10.0.4.15');
      expect(masked).not.toContain('192.168.1.100');
      expect(masked).not.toContain('172.16.0.5');
      expect(masked).toContain('[REDACTED_BY_THE_PROFESSOR:IP_ADDR]');
    });

    it('should obfuscate internal domain URLs', () => {
      const input = `
+const API_ENDPOINT = "https://service.internal.corp/api/v1/user";
+const CLUSTER_URL = "http://vault.cluster.local:8200";
      `;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain('service.internal.corp');
      expect(masked).not.toContain('vault.cluster.local');
      expect(masked).toContain('[REDACTED_BY_THE_PROFESSOR:INTERNAL_URL]');
    });

    it('should mask database connection strings with passwords', () => {
      const input = `
+const DB_URL = "postgres://admin:SuperSecretPass123!@db.internal:5432/production";
      `;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain('SuperSecretPass123!');
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should redact JWT bearer tokens', () => {
      const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const input = `
+const headers = { Authorization: "Bearer ${jwtToken}" };
      `;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain(jwtToken);
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should mask private key blocks', () => {
      const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3vX...
-----END RSA PRIVATE KEY-----`;
      const input = `
+const privateKey = \`${privateKey}\`;
      `;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain('MIIEowIBAAKCAQEA0Z3vX...');
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should preserve surrounding code context while redacting secrets', () => {
      const input = `
+function authenticateUser(req, res) {
+  const apiKey = "sk-proj-1234567890123456789012345678901234567890";
+  console.log(process.env.PUBLIC_VAR);
+  return validateKey(apiKey);
+}
      `;
      const masked = maskIngressFileContent(input);
      expect(masked).toContain('function authenticateUser(req, res)');
      expect(masked).toContain('console.log(process.env.PUBLIC_VAR)');
      expect(masked).toContain('return validateKey(');
      expect(masked).not.toContain('sk-proj-1234567890123456789012345678901234567890');
    });

    it('should mask high-entropy custom authorization tokens', () => {
      const customToken = 'xoxb-123456789012-1234567890123-4567890123456';
      const input = `+const slackToken = "${customToken}";`;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain(customToken);
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should leave non-secret environment variable usages intact', () => {
      const input = `+const port = process.env.PORT || 3000;`;
      const masked = maskIngressFileContent(input);
      expect(masked).toContain('process.env.PORT');
      expect(masked).not.toContain(REDACTION_PLACEHOLDER);
    });

    it('should obfuscate GitLab personal access tokens', () => {
      const gitlabToken = 'glpat-12345678901234567890';
      const input = `+const token = "${gitlabToken}";`;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain(gitlabToken);
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should obfuscate HashiCorp Vault tokens', () => {
      const vaultToken = 'hvs.123456789012345678901234';
      const input = `+const vaultKey = "${vaultToken}";`;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain(vaultToken);
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should obfuscate Stripe live/test secret keys', () => {
      const stripeKey = 'sk_live_mock_test_key_123456789012345';
      const input = `+const stripeSecret = "${stripeKey}";`;
      const masked = maskIngressFileContent(input);
      expect(masked).not.toContain(stripeKey);
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });

    it('should handle large batches with multi-file diffs gracefully', () => {
      const largeDiff = Array.from({ length: 50 }, (_, i) => `
+const fileSecret${i} = "sk-proj-${i}00000000000000000000000000000000000";
+const host${i} = "10.0.1.${i}";
`).join('\n');
      const masked = maskIngressFileContent(largeDiff);
      expect(masked).not.toContain('10.0.1.');
      expect(masked).toContain('[REDACTED_BY_THE_PROFESSOR:IP_ADDR]');
      expect(masked).toContain(REDACTION_PLACEHOLDER);
    });
  });

  describe('Context-Targeted Isolation', () => {
    it('should isolate changed hunks and declaration lines when targeted context is enabled', () => {
      const fileContent = `
// Unchanged block
const a = 1;
const b = 2;

export function handlePayment() {
+  const apiKey = "sk-proj-9999999999999999999999999999999999999999";
+  return processPayment();
}
      `;
      const isolated = maskIngressFileContent(fileContent, { enableTargetedContextIsolation: true });
      expect(isolated).toContain('export function handlePayment()');
      expect(isolated).toContain('+  const apiKey =');
      expect(isolated).not.toContain('sk-proj-9999999999999999999999999999999999999999');
    });
  });

  describe('Audit Trail Verification', () => {
    it('should track applied secret rules in audit result', () => {
      const text = 'const db = "postgres://user:SecretPwd123@localhost/db";';
      const audit = auditSecretMasking(text);
      expect(audit.containsMaskedSecrets).toBe(true);
      expect(audit.appliedRuleIds).toContain('db-uri-password');
      expect(audit.maskedText).toContain(REDACTION_PLACEHOLDER);
    });
  });

  describe('Enterprise Zero Retention & Privacy Headers', () => {
    it('should generate appropriate zero retention privacy headers', () => {
      const headers = getEnterprisePrivacyHeaders({
        provider: 'groq-enterprise',
        zeroDataRetention: true,
        enablePrecomputationScrubbing: true,
        enableEntropyMasking: true,
        enableRegexRedaction: true,
        isolateContextHunks: false,
      });

      expect(headers['X-Enterprise-Zero-Retention']).toBe('true');
      expect(headers['X-Data-Opt-Out']).toBe('1');
      expect(headers['X-No-Model-Training']).toBe('true');
    });

    it('should correctly identify local self-hosted endpoints', () => {
      expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true);
      expect(isLocalEndpoint('http://127.0.0.1:8080')).toBe(true);
      expect(isLocalEndpoint('http://10.0.0.5:8000')).toBe(true);
      expect(isLocalEndpoint('https://api.groq.com/openai/v1')).toBe(false);
    });

    it('should log egress transmission metrics in auditor', () => {
      EgressSecurityAuditor.clearAuditLogs();
      EgressSecurityAuditor.logEgressTransmission('groq-enterprise', 5, 12, true);

      const logs = EgressSecurityAuditor.getAuditLogs();
      expect(logs.length).toBe(1);
      expect(logs[0].provider).toBe('groq-enterprise');
      expect(logs[0].fileCount).toBe(5);
      expect(logs[0].secretsRedactedCount).toBe(12);
      expect(logs[0].zeroRetentionEnforced).toBe(true);
    });
  });
});

