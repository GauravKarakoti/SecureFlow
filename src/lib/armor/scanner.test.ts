import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maskSecrets, ArmorIQScanner } from './scanner';
import Groq from 'groq-sdk';

vi.mock('groq-sdk', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({ findings: [] }),
        },
      },
    ],
  });
  return {
    default: class MockGroq {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
      static mockCreate = mockCreate;
    },
  };
});

const mockCreate = (Groq as any).mockCreate;

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

describe('ArmorIQScanner batching and truncation', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it('batches multiple small files under the limit', async () => {
    const scannerInstance = new ArmorIQScanner();
    const files = [
      { filename: 'file1.ts', patch: '+const a = 1;' },
      { filename: 'file2.ts', patch: '+const b = 2;' },
      { filename: 'file3.ts', patch: '+const c = 3;' },
    ];

    await scannerInstance.scanPullRequest(files);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const lastCallArg = mockCreate.mock.calls[0][0];
    const promptContent = lastCallArg.messages[1].content;
    
    expect(promptContent).toContain('<file name="file1.ts"');
    expect(promptContent).toContain('const a = 1;');
    expect(promptContent).toContain('<file name="file2.ts"');
    expect(promptContent).toContain('const b = 2;');
    expect(promptContent).toContain('<file name="file3.ts"');
    expect(promptContent).toContain('const c = 3;');
  });

  it('splits into multiple batches when total size exceeds MAX_COMBINED_LENGTH', async () => {
    const scannerInstance = new ArmorIQScanner();
    const file1Content = 'a'.repeat(18000);
    const file2Content = 'b'.repeat(18000);
    
    const files = [
      { filename: 'large1.ts', patch: `+${file1Content}` },
      { filename: 'large2.ts', patch: `+${file2Content}` },
    ];

    await scannerInstance.scanPullRequest(files);

    expect(mockCreate).toHaveBeenCalledTimes(2);

    const firstCallPrompt = mockCreate.mock.calls[0][0].messages[1].content;
    const secondCallPrompt = mockCreate.mock.calls[1][0].messages[1].content;

    expect(firstCallPrompt).toContain('<file name="large1.ts"');
    expect(firstCallPrompt).not.toContain('<file name="large2.ts"');

    expect(secondCallPrompt).toContain('<file name="large2.ts"');
    expect(secondCallPrompt).not.toContain('<file name="large1.ts"');
  });

  it('truncates a single large file cleanly at line boundary and preserves closing tag', async () => {
    const scannerInstance = new ArmorIQScanner();
    const lines: string[] = [];
    for (let i = 0; i < 35; i++) {
      lines.push('+' + 'c'.repeat(999));
    }
    const largeContent = lines.join('\n');
    const files = [
      { filename: 'huge.ts', patch: largeContent },
    ];

    await scannerInstance.scanPullRequest(files);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const promptContent = mockCreate.mock.calls[0][0].messages[1].content;

    expect(promptContent).toContain('<file name="huge.ts"');
    expect(promptContent).toContain('...[TRUNCATED FOR SIZE]...');
    expect(promptContent).toContain('</file>');
    
    expect(promptContent).toContain('c\n\n...[TRUNCATED FOR SIZE]...\n</file>');
  });
});
