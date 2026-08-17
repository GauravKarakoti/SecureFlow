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
