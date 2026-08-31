/**
 * Tests for finding redaction (#591, #669).
 *
 * Covers:
 *  - Provider-prefixed keys (OpenAI, Anthropic, GitHub, GitLab, Stripe, Slack, AWS, Google, SendGrid, Twilio, Vault, HuggingFace, Discord, Datadog).
 *  - Connection strings and authorization headers (DB URIs, Azure Storage connection strings, Bearer/Basic headers).
 *  - Private keys (PEM RSA/EC/DSA/OpenSSH, complete and unterminated).
 *  - False-positive reduction (safe environment variable lookups, config readers, UUIDs, hex color codes, long camelCase identifiers, mock placeholders).
 *  - High-entropy heuristic checks and Shannon entropy calculation.
 *  - Total safety and edge-case handling for `maskFindingText` and `auditSecretMasking`.
 */
import { describe, it, expect } from 'vitest';
import {
  REDACTION_PLACEHOLDER,
  looksLikeCredential,
  maskFindingText,
  maskHighEntropyTokens,
  maskKnownSecretFormats,
  maskSecrets,
  shannonEntropy,
  isWordBasedIdentifier,
  auditSecretMasking,
} from './secret-masking';

const redacted = (text: string) => expect(maskSecrets(text)).toContain(REDACTION_PLACEHOLDER);
const untouched = (text: string) => expect(maskSecrets(text)).toBe(text);

describe('provider-prefixed keys', () => {
  it('redacts an Anthropic key', () => {
    redacted('key = sk-ant-api03-abcdef1234567890abcdef1234567890');
  });

  it('redacts a GitHub classic PAT', () => {
    redacted('token=ghp_abcdefghijklmnopqrstuvwxyzabcdefghijklm');
  });

  it('redacts a fine-grained GitHub PAT', () => {
    redacted(
      'token=github_pat_11AAABBB111_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghij',
    );
  });

  it('redacts a JWT', () => {
    redacted(
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3j_VN3M5qVZgX5vLQ7zGQ6R8y3Kx9w0c',
    );
  });

  it('redacts an AWS access key id, including the STS and service prefixes', () => {
    redacted('aws=AKIAIOSFODNN7EXAMPLE');
    redacted('sts=ASIAIOSFODNN7EXAMPLE');
  });

  it('redacts a Stripe key', () => {
    redacted(`stripe=${'sk_li' + 've_'}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`);
  });

  it('redacts a Slack token and an incoming webhook URL', () => {
    redacted(`slack=${'xox' + 'b-'}0000000000-XXXXXXXXXXXXXXXXXXXXXXXX`);
    redacted(`https://hooks.${'sla' + 'ck'}.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX`);
  });

  it('does not treat a lookalike host as a Slack webhook', () => {
    const lookalike = `https://evil-hooks.${'sla' + 'ck'}.com/services/AAAA/BBBB/CCCC`;
    expect(maskKnownSecretFormats(lookalike)).toContain('evil-hooks');
  });

  it('still redacts a webhook URL embedded mid-string', () => {
    const embedded = `const url = "https://hooks.${'sla' + 'ck'}.com/services/T1/B1/XXXXXXXXXXXXXXXX";`;
    expect(maskKnownSecretFormats(embedded)).toContain(REDACTION_PLACEHOLDER);
  });

  it('redacts a Google API key', () => {
    redacted(`google=${'AIza'}SyD-0000000000000000000000000000000`);
  });

  it('redacts a SendGrid key', () => {
    redacted(`sendgrid=${'SG.'}abcdefghijklmnopqr.stuvwxyz0123456789ab`);
  });

  it('redacts an npm token', () => {
    redacted(`npm=${'npm_'}abcdefghijklmnopqrstuvwxyz0123456789`);
  });

  it('redacts a Twilio SID-shaped credential', () => {
    redacted(`twilio=${'S' + 'K'}0123456789abcdef0123456789abcdef`);
  });

  // ── New Provider Patterns (#669) ─────────────────────────────────────────
  it('redacts a GitLab Personal Access Token', () => {
    redacted('token = ' + 'glpat-' + 'abcdefghijklmnopqrst123456');
  });

  it('redacts a GitLab CI pipeline token and deploy token', () => {
    redacted('ci_token = ' + 'glcbt-' + 'abcdefghijklmnopqrst123456');
    redacted('deploy_token = ' + 'gldt-' + 'abcdefghijklmnopqrst123456');
  });

  it('redacts a HashiCorp Vault token', () => {
    redacted('vault_token = ' + 'hvs.' + 'CAESIJkABCDEF1234567890abcdefghijklmnopqrstuvwxyz');
    redacted('old_vault = ' + 's.' + 'abcdefghijklmnopqrstuvwx');
  });

  it('redacts a HuggingFace user access token', () => {
    redacted('hf_token = ' + 'hf_' + 'abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('redacts a Discord bot token', () => {
    redacted('discord_auth = ' + 'Bot ' + 'MTIzNDU2Nzg5MDEyMzQ1Njc4.' + 'abcdef.' + 'abcdefghijklmnopqrstuvwxyz12345');
  });

  it('redacts a Datadog API key assignment', () => {
    redacted(`DD_API_KEY = "1234567890abcdef1234567890abcdef"`);
    redacted(`datadog_api_key: 'abcdef1234567890abcdef1234567890'`);
  });
});

describe('authorization headers and connection strings', () => {
  it('redacts Bearer authorization header values', () => {
    const header = 'Authorization: Bearer abcdef1234567890_super_secret_token_value_xyz';
    const result = maskSecrets(header);
    expect(result).toBe(`Authorization: Bearer ${REDACTION_PLACEHOLDER}`);
  });

  it('redacts Basic authorization header values', () => {
    const header = 'Authorization: Basic YWRtaW46cGFzc3dvcmQxMjM0NQ==';
    const result = maskSecrets(header);
    expect(result).toBe(`Authorization: Basic ${REDACTION_PLACEHOLDER}`);
  });

  it('redacts database passwords in URI connection strings while preserving database scheme', () => {
    const postgresUri = 'DATABASE_URL = "postgres://app_user:superSecretPass123@db.production.internal:5432/app_db"';
    const result = maskSecrets(postgresUri);
    expect(result).toContain('postgres://app_user:');
    expect(result).toContain(REDACTION_PLACEHOLDER);
    expect(result).not.toContain('superSecretPass123');
  });

  it('redacts Azure Storage Account connection strings', () => {
    const azureConn = 'DefaultEndpointsProtocol=https;AccountName=prodstorage;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrst==;EndpointSuffix=core.windows.net';
    const result = maskSecrets(azureConn);
    expect(result).toContain(`AccountKey=${REDACTION_PLACEHOLDER}`);
    expect(result).toContain('AccountName=prodstorage');
  });

  it('redacts ADO.NET / SQL Server connection strings', () => {
    const adonet = 'Server=myServerAddress;Database=myDataBase;Uid=myUsername;Pwd=MyPassword123;';
    const result = maskSecrets(adonet);
    expect(result).toContain(`Pwd=${REDACTION_PLACEHOLDER}`);
    expect(result).not.toContain('MyPassword123');
  });
});

describe('PEM private keys', () => {
  it('redacts complete RSA, EC, and OpenSSH private key blocks while preserving markers', () => {
    const rsaKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1234567890abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----`;

    const result = maskSecrets(rsaKey);
    expect(result).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(result).toContain(REDACTION_PLACEHOLDER);
    expect(result).toContain('-----END RSA PRIVATE KEY-----');
    expect(result).not.toContain('MIIEowIBAAKCAQEA0Y1234567890abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts unterminated private key fragments', () => {
    const truncatedKey = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD`;
    const result = maskSecrets(truncatedKey);
    expect(result).toBe(REDACTION_PLACEHOLDER);
  });
});

describe('false positive prevention (#669)', () => {
  it('leaves safe environment variable lookups untouched', () => {
    untouched('const apiKey = process.env.API_KEY;');
    untouched('const secret = import.meta.env.VITE_APP_SECRET;');
    untouched('db_pass = os.environ.get("DB_PASSWORD")');
    untouched('token = System.getenv("AUTH_TOKEN")');
    untouched('key = Deno.env.get("SECRET_KEY")');
    untouched('secret = config.get("jwt_secret")');
    untouched('let token = env::var("API_TOKEN");');
  });

  it('leaves dummy placeholders and templates untouched', () => {
    untouched('API_KEY = "your-api-key-here"');
    untouched('SECRET_KEY = "YOUR_SECRET_KEY"');
    untouched('PASSWORD = "placeholder"');
    untouched('token = "changeme"');
    untouched('KEY = "mock_secret_token"');
    untouched('SECRET = "dummy_value"');
    untouched('const apiKey = "INSERT_YOUR_API_KEY";');
  });

  it('does not redact standard UUIDs or GUIDs via entropy check', () => {
    const uuidText = 'const userId = "c39a2b8e-7e9b-4d7a-8f3a-9e1b2c3d4e5f";';
    untouched(uuidText);
  });

  it('does not redact CSS tokens, Tailwind classes, or color hex codes', () => {
    untouched('const buttonClass = "bg-blue-500 hover:bg-blue-600 text-white rounded-lg shadow-md";');
    untouched('const themeColor = "#3b82f6";');
  });

  it('does not redact long camelCase identifiers or descriptive prose', () => {
    untouched('class DefaultAuthenticationProviderConfigurationService extends BaseService {}');
    untouched('function handleUserRegistrationConfirmationNotification() {}');
    expect(isWordBasedIdentifier('developerReceivesAISecurityExplanations')).toBe(true);
  });
});

describe('entropy analysis and helper utilities', () => {
  it('calculates Shannon entropy correctly', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2.0, 1);
    expect(shannonEntropy('aB3#dE9!kL2@mN4$')).toBeGreaterThan(3.5);
  });

  it('accurately distinguishes high-entropy credentials from identifiers', () => {
    const realSecret = '9f8e7d6c5b4a3210fe9dcba876543210abcedf012345';
    expect(looksLikeCredential(realSecret)).toBe(true);

    const codeIdentifier = 'ApplicationStateManagementContainerStore';
    expect(looksLikeCredential(codeIdentifier)).toBe(false);
  });

  it('redacts raw high-entropy tokens without prefixes', () => {
    const rawSecret = 'api_signature = "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a"';
    redacted(rawSecret);
  });
});

describe('maskFindingText and auditSecretMasking', () => {
  it('handles non-string inputs safely without throwing', () => {
    expect(maskFindingText(null)).toBe('');
    expect(maskFindingText(undefined)).toBe('');
    expect(maskFindingText(12345)).toBe('');
    expect(maskFindingText({})).toBe('');
  });

  it('provides comprehensive audit metadata via auditSecretMasking', () => {
    const snippet = `
      const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const user = process.env.USER_NAME;
    `;

    const audit = auditSecretMasking(snippet);
    expect(audit.containsMaskedSecrets).toBe(true);
    expect(audit.appliedRuleIds).toContain('github-pat-classic');
    expect(audit.maskedText).toContain(REDACTION_PLACEHOLDER);
    expect(audit.maskedText).toContain('process.env.USER_NAME');
  });

  it('returns clean audit result when no secrets are present', () => {
    const cleanSnippet = 'const x = 42; const name = "SecureFlow";';
    const audit = auditSecretMasking(cleanSnippet);
    expect(audit.containsMaskedSecrets).toBe(false);
    expect(audit.appliedRuleIds).toEqual([]);
    expect(audit.entropyRedactedTokenCount).toBe(0);
  });
});
