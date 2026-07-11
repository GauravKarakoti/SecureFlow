import { describe, it, expect } from 'vitest';
import { maskSecrets } from './scanner';

describe('maskSecrets redactor', () => {
  it('passes normal safe text without modification', () => {
    const input = 'const x = 10;';
    expect(maskSecrets(input)).toBe(input);
  });

  it('redacts Anthropic API keys', () => {
    const key = 'sk-' + 'ant-api03-THISisNOTaREALanthropicKEYplaceholder';
    const input = `const client = new Anthropic({ apiKey: "${key}" });`;
    expect(maskSecrets(input)).toBe('const client = new Anthropic({ apiKey: "[REDACTED_BY_THE_PROFESSOR]" });');
  });

  it('redacts classic GitHub personal access tokens', () => {
    const token = 'ghp' + '_THISisNOTaREALgithubTOKENplaceholder';
    const input = `const token = "${token}";`;
    expect(maskSecrets(input)).toBe('const token = "[REDACTED_BY_THE_PROFESSOR]";');
  });

  it('redacts fine-grained GitHub personal access tokens', () => {
    const token = 'github_' + 'pat_THISisNOTaREALgithubPATplaceholder1234567890abcdefghijklmnopqrstuvwxyz1234567890abc';
    const input = `const token = "${token}";`;
    expect(maskSecrets(input)).toBe('const token = "[REDACTED_BY_THE_PROFESSOR]";');
  });

  it('redacts JWTs starting with eyJhbGciOi', () => {
    const jwt = 'eyJhbGciOi' + 'JIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwbGFjZWhvbGRlciJ9.THISisNOTaREALjwtSIGNATUREplaceholder';
    const input = `const jwt = "${jwt}";`;
    expect(maskSecrets(input)).toBe('const jwt = "[REDACTED_BY_THE_PROFESSOR]";');
  });

  it('redacts generic sk- API keys (OpenAI etc.)', () => {
    const key = 'sk-' + 'THISisNOTaREALopenaiKEYplaceholder123';
    const input = `const apiKey = "${key}";`;
    expect(maskSecrets(input)).toBe('const apiKey = "[REDACTED_BY_THE_PROFESSOR]";');
  });

  it('redacts Stripe keys', () => {
    const key = 'sk_live' + '_THISisNOTaREALstripeKEYplaceholder';
    const input = `const stripeKey = "${key}";`;
    expect(maskSecrets(input)).toBe('const stripeKey = "[REDACTED_BY_THE_PROFESSOR]";');
  });

  it('redacts Slack tokens', () => {
    const token = 'xoxb' + '-THISisNOTaREALslackTOKENplaceholder';
    const input = `const slackToken = "${token}";`;
    expect(maskSecrets(input)).toBe('const slackToken = "[REDACTED_BY_THE_PROFESSOR]";');
  });

  it('redacts database passwords in URI strings', () => {
    const uri = 'postgresql://postgres:' + 'THIS_is_a_SAFE_placeholder_password_123@localhost:5432/neondb';
    expect(maskSecrets(uri)).toBe('postgresql://postgres:[REDACTED_BY_THE_PROFESSOR]@localhost:5432/neondb');
  });
});
