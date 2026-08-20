/**
 * Tests for finding redaction (#591).
 *
 * Two properties matter beyond "does it catch X":
 *
 *  - the entropy pass must not flatten ordinary code. Getting that wrong in the
 *    permissive direction is worse than missing a secret, because it destroys
 *    the very snippet the remediation advice is talking about; and
 *  - `maskFindingText` must be total, because it is now on the path of two
 *    model-generated fields that can be anything at all.
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
    // Split, like the Stripe and Slack fixtures above: an intact literal trips
    // GitHub's own push protection on this very repository.
    redacted(`https://hooks.${'sla' + 'ck'}.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX`);
  });

  // ── Newly covered ────────────────────────────────────────────────────────
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
});

describe('rule ordering', () => {
  it('fires the sk-proj- rule, which the broader sk- rule used to swallow', () => {
    // Previously unreachable: `sk-[a-zA-Z0-9-_]{32,}` ran first and consumed the
    // match, so the more specific rule below it could never apply.
    const result = maskKnownSecretFormats('key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890abcdef');

    expect(result).toContain(REDACTION_PLACEHOLDER);
    expect(result).not.toContain('sk-proj-');
  });
});

describe('private keys', () => {
  const body = ['MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qs2c1t2M2Y', 'ZmFrZWtleWJvZHlsaW5ldHdv'].join(
    '\n',
  );

  it('redacts the body of a PEM block and keeps the markers', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const result = maskSecrets(pem);

    expect(result).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(result).toContain('-----END RSA PRIVATE KEY-----');
    expect(result).toContain(REDACTION_PLACEHOLDER);
    expect(result).not.toContain('MIIEowIBAAKCAQEA');
  });

  it.each(['RSA ', 'EC ', 'OPENSSH ', ''])('handles a %j private key header', (kind) => {
    const pem = `-----BEGIN ${kind}PRIVATE KEY-----\n${body}\n-----END ${kind}PRIVATE KEY-----`;

    expect(maskSecrets(pem)).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('redacts a truncated key that has no END marker', () => {
    // A snippet cut at the size cap frequently carries the header and the first
    // lines of the body. Those lines are still key material.
    const truncated = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`;

    expect(maskSecrets(truncated)).not.toContain('MIIEowIBAAKCAQEA');
  });
});

describe('connection strings', () => {
  it('redacts the password and keeps the scheme and username', () => {
    const result = maskSecrets('mongodb://user:supersecret@localhost:27017/mydb');

    expect(result).toContain('mongodb://user:');
    expect(result).not.toContain('supersecret');
  });

  it.each(['postgresql', 'mysql', 'redis', 'amqp'])('covers the %s scheme', (scheme) => {
    expect(maskSecrets(`${scheme}://svc:hunter2pass@db.internal:5432/app`)).not.toContain(
      'hunter2pass',
    );
  });

  it('covers a scheme the list does not name', () => {
    expect(maskSecrets('customproto://svc:hunter2pass@host/path')).not.toContain('hunter2pass');
  });

  it('redacts an ADO.NET-style connection string', () => {
    const result = maskSecrets('Server=db;User Id=sa;Password=Tr0ub4dor;Encrypt=true');

    expect(result).not.toContain('Tr0ub4dor');
    expect(result).toContain('Server=db');
    expect(result).toContain('Encrypt=true');
  });
});

describe('generic assignments', () => {
  it('redacts the value and keeps the variable name', () => {
    // The name is not the secret, and a reviewer needs it to act on the finding.
    // This is why `scrubCredentials` — which collapses the whole pair to
    // [REDACTED_SECRET] — is not used on finding text.
    const result = maskSecrets('const DB_PASSWORD = "Tr0ub4dor&3";');

    expect(result).toContain('DB_PASSWORD');
    expect(result).not.toContain('Tr0ub4dor');
  });

  it.each([
    'const apiSecret = "a83f9d2e4b";',
    "let authToken: 'abcd1234efgh';",
    'AUTH_TOKEN=hunter2pass',
    'apiKey = "0123456789abcdef"',
  ])('redacts %j', (source) => {
    expect(maskSecrets(source)).toContain(REDACTION_PLACEHOLDER);
  });

  it('leaves an environment-variable reference alone', () => {
    // The correct handling of a secret, and the thing the scanner is trying to
    // encourage. Redacting it would make the remediation advice unreadable.
    untouched('const apiKey = process.env.API_KEY;');
    untouched('const token = import.meta.env.VITE_TOKEN;');
  });

  it('leaves template interpolation alone', () => {
    untouched('const authHeader = `${bearerPrefix}`;');
  });

  it('leaves an obvious placeholder alone', () => {
    // Otherwise every .env.example in every repository comes back as a wall of
    // redactions, which is noise, not security.
    untouched('API_KEY=your_key_here');
    untouched('SECRET_TOKEN=changeme');
    untouched('DB_PASSWORD=<your-password>');
  });

  it('leaves a variable with no secret-ish name alone', () => {
    untouched('const greeting = "hello there";');
  });
});

describe('shannonEntropy', () => {
  it('is zero for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });

  it('is one bit for an even two-symbol alphabet', () => {
    expect(shannonEntropy('abababab')).toBeCloseTo(1, 10);
  });

  it('is zero for the empty string rather than NaN', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('rates a random-looking token above ordinary prose', () => {
    expect(shannonEntropy('aG9sYVR3aWxpZ2h0OTk5MjIyMzMz')).toBeGreaterThan(
      shannonEntropy('the quick brown fox'),
    );
  });
});

describe('looksLikeCredential', () => {
  it('accepts a long mixed-case alphanumeric token', () => {
    expect(looksLikeCredential('aG9sYVR3aWxpZ2h0OTk5MjIyMzMz')).toBe(true);
  });

  it('accepts a long hex digest', () => {
    expect(looksLikeCredential('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe(
      true,
    );
  });

  it('rejects a long identifier', () => {
    // 39 characters, entropy ~3.8 bits — comfortably over the threshold. A bare
    // entropy check would redact half the identifiers in this repository, which
    // is why the character-class test exists.
    expect(looksLikeCredential('developerReceivesAISecurityExplanations')).toBe(false);
    expect(looksLikeCredential('ArmorIQPolicyEngineEvaluateFindings')).toBe(false);
  });

  it('rejects a token shorter than the minimum length', () => {
    expect(looksLikeCredential('aB3dE6gH9')).toBe(false);
  });

  it('rejects a long run of a single character', () => {
    expect(looksLikeCredential('X'.repeat(64))).toBe(false);
  });
});

describe('maskHighEntropyTokens', () => {
  it('redacts a prefix-less credential the named rules cannot see', () => {
    const result = maskHighEntropyTokens('oauthSecret 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2');

    expect(result).toContain(REDACTION_PLACEHOLDER);
  });

  it('leaves ordinary source code untouched', () => {
    const source = [
      'import { developerReceivesAISecurityExplanations } from "@/ai/flows";',
      'export async function scanPullRequest(files: FileChange[]) {',
      '  const commentableLines = new Map<string, Set<number>>();',
      '  return normalizeSeverity(finding.severity);',
      '}',
    ].join('\n');

    expect(maskHighEntropyTokens(source)).toBe(source);
  });

  it('leaves a long URL path untouched', () => {
    const url = 'https://github.com/GauravKarakoti/SecureFlow/blob/main/src/lib/armor/scanner.ts';

    expect(maskHighEntropyTokens(url)).toBe(url);
  });

  it('does not re-redact the placeholder itself', () => {
    expect(maskHighEntropyTokens(REDACTION_PLACEHOLDER)).toBe(REDACTION_PLACEHOLDER);
  });
});

describe('maskSecrets — preserved behaviour', () => {
  it('returns the empty string unchanged', () => {
    expect(maskSecrets('')).toBe('');
  });

  it('returns non-secret text unchanged', () => {
    untouched('const x = 42; // normal comment');
  });

  it('is idempotent', () => {
    const once = maskSecrets('token=ghp_abcdefghijklmnopqrstuvwxyzabcdefghijklm');

    expect(maskSecrets(once)).toBe(once);
  });
});

describe('maskFindingText', () => {
  it('redacts model prose that quotes a credential back at the reader', () => {
    // The exact shape a remediation takes, and the one that used to reach a
    // public pull request comment with no redaction at all.
    const remediation =
      'Replace the hardcoded value on line 12 — move DB_PASSWORD=Tr0ub4dorHunter into an environment variable.';

    expect(maskFindingText(remediation)).not.toContain('Tr0ub4dorHunter');
  });

  it('keeps the variable name so the advice still makes sense', () => {
    expect(maskFindingText('Set DB_PASSWORD="Tr0ub4dorHunter" from the environment.')).toContain(
      'DB_PASSWORD',
    );
  });

  it.each([null, undefined, 42, {}, []])('returns a string for %j rather than throwing', (input) => {
    expect(() => maskFindingText(input)).not.toThrow();
    expect(typeof maskFindingText(input)).toBe('string');
  });

  it('passes an empty string straight through', () => {
    expect(maskFindingText('')).toBe('');
  });
});
