import { describe, it, expect } from 'vitest';
import { scrubCredentials, scrubFilesystemPaths, scrubSensitiveData } from './redaction';
import { scrubSensitiveData as reExported } from './middleware/error-handler';

describe('scrubCredentials', () => {
  it('removes a Postgres password from a connection string', () => {
    const scrubbed = scrubCredentials(
      "Can't reach database server at postgresql://neondb_owner:hunter2@ep-x.neon.tech/neondb"
    );

    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('[REDACTED_CONNECTION_STRING]');
  });

  it('removes userinfo from any URL authority', () => {
    expect(scrubCredentials('fetching https://token@github.com/org/repo')).toContain(
      '[REDACTED_CREDENTIALS]'
    );
  });

  it('removes KEY=value secrets', () => {
    for (const text of [
      'GITHUB_CLIENT_SECRET=abc123',
      'authToken = xyz',
      'DATABASE_URL=postgres://a',
    ]) {
      expect(scrubCredentials(text)).toContain('[REDACTED_SECRET]');
    }
  });

  it('leaves ordinary text alone', () => {
    expect(scrubCredentials('scan complete for org/repo #42')).toBe(
      'scan complete for org/repo #42'
    );
  });

  it('leaves a repository-relative path alone', () => {
    // This is the difference that matters for logs: a file path is the most
    // useful field in a scanner record.
    expect(scrubCredentials('finding in src/lib/armor/scanner.ts')).toBe(
      'finding in src/lib/armor/scanner.ts'
    );
  });

  it('handles empty input', () => {
    expect(scrubCredentials('')).toBe('');
  });
});

describe('scrubFilesystemPaths', () => {
  it('removes absolute Unix paths', () => {
    expect(scrubFilesystemPaths('at /usr/local/app/server.js:12')).toContain('[REDACTED_PATH]');
  });

  it('removes Windows paths', () => {
    expect(scrubFilesystemPaths('at D:\\Projects\\SecureFlow\\src')).toContain('[REDACTED_PATH]');
  });

  it('does not touch a relative path', () => {
    expect(scrubFilesystemPaths('src/db.ts')).toBe('src/db.ts');
  });
});

describe('scrubSensitiveData', () => {
  it('applies both passes', () => {
    const scrubbed = scrubSensitiveData(
      'postgresql://u:p@h/db failed at /usr/local/app/server.js'
    );

    expect(scrubbed).toContain('[REDACTED_CONNECTION_STRING]');
    expect(scrubbed).toContain('[REDACTED_PATH]');
  });

  it('is still exported from error-handler for existing callers', () => {
    // The implementation moved to break an import cycle with the logger; the
    // old import path must keep working.
    expect(reExported).toBe(scrubSensitiveData);
  });
});

describe('credentials quoted in prose (#690)', () => {
  // The existing rules are all shaped around `name=value` or a URL authority.
  // A provider error such as GitHub's `Bad credentials for token ghp_…` matched
  // none of them and went through untouched.
  it.each([
    ['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a GitHub personal access token'],
    ['gho_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a GitHub OAuth token'],
    ['ghs_cccccccccccccccccccccccccccccccccccc', 'a GitHub App installation token'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop', 'a fine-grained GitHub token'],
    ['glpat-xxxxxxxxxxxxxxxxxxxx', 'a GitLab token'],
    ['sk-abcdefghijklmnopqrstuvwxyz012345', 'an OpenAI-style key'],
    ['xoxb-123456789012-abcdefghijkl', 'a Slack token'],
    ['AKIAIOSFODNN7EXAMPLE', 'an AWS access key id'],
  ])('redacts %s (%s)', (token) => {
    const scrubbed = scrubCredentials(`Bad credentials for token ${token}`);

    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('[REDACTED_TOKEN]');
  });

  it('redacts an Authorization header value', () => {
    const scrubbed = scrubCredentials(
      'Request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'
    );

    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubbed).toContain('Bearer [REDACTED_TOKEN]');
  });

  it('leaves a content fingerprint alone', () => {
    // A SHA-256 digest in a log line is evidence, not a leak, and the triage
    // system keys off exactly these.
    const digest = 'a'.repeat(64);
    expect(scrubCredentials(`fingerprint ${digest}`)).toContain(digest);
  });

  it('leaves ordinary prose alone', () => {
    const message = 'Repository owner/name is already claimed by another user';
    expect(scrubCredentials(message)).toBe(message);
  });

  it('still redacts the shapes it always did', () => {
    expect(scrubCredentials('postgresql://user:pw@host/db')).toContain(
      '[REDACTED_CONNECTION_STRING]'
    );
    expect(scrubCredentials('GITHUB_CLIENT_SECRET=abc123')).toContain('[REDACTED_SECRET]');
  });
});
