import { describe, it, expect } from 'vitest';
import { githubWebhookSchema } from './schemas';

describe('githubWebhookSchema', () => {
  it('accepts a minimal pull_request payload', () => {
    const payload = {
      action: 'opened',
      pull_request: {
        id: 1,
        number: 42,
        title: 'Fix bug',
        state: 'open',
        head: { sha: 'abc123' },
      },
      repository: {
        id: 99,
        name: 'repo',
        full_name: 'org/repo',
        owner: { login: 'org' },
      },
      installation: { id: 7 },
      sender: { id: 123 },
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts an installation payload without repository or pull_request', () => {
    const payload = {
      action: 'created',
      installation: { id: 5 },
      sender: { id: 456 },
      repositories: [
        { id: 1, name: 'a', full_name: 'org/a' },
        { id: 2, name: 'b', full_name: 'org/b' },
      ],
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories).toHaveLength(2);
      // id should be transformed to string via the z.number().or(z.string()) transform
      expect(typeof result.data.repositories![0].id).toBe('string');
    }
  });

  it('accepts an installation_repositories payload with repositories_added', () => {
    const payload = {
      action: 'added',
      installation: { id: 10 },
      sender: { id: 789 },
      repositories_added: [
        { id: 100, name: 'new-repo', full_name: 'org/new-repo' },
      ],
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.repositories_added).toHaveLength(1);
      expect(typeof result.data.repositories_added![0].id).toBe('string');
    }
  });

  it('coerces numeric id fields to string via transform', () => {
    const payload = {
      action: 'opened',
      pull_request: { id: 1, number: 42, title: 'PR', state: 'open', head: { sha: 'x' } },
      repository: { id: 99, name: 'r', full_name: 'o/r', owner: { login: 'o' } },
      installation: { id: 7 },
      sender: { id: 123 },
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.repository?.id).toBe('string');
      expect(typeof result.data.pull_request?.id).toBe('string');
    }
  });

  it('coerces string id fields correctly', () => {
    const payload = {
      action: 'opened',
      pull_request: { id: '1', number: 42, title: 'PR', state: 'open', head: { sha: 'x' } },
      repository: { id: '99', name: 'r', full_name: 'o/r', owner: { login: 'o' } },
      installation: { id: '7' },
      sender: { id: '123' },
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.repository?.id).toBe('string');
      expect(typeof result.data.sender?.id).toBe('string');
      expect(typeof result.data.installation?.id).toBe('number'); // installation uses Number()
    }
  });

  it('rejects payload with missing required nested fields', () => {
    const payload = {
      action: 'opened',
      // pull_request is missing head.sha
      pull_request: { id: 1, number: 42, title: 'PR', state: 'open' },
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('accepts a payload with only optional fields absent', () => {
    const payload = {
      action: 'deleted',
      installation: { id: 3 },
      sender: { id: 999 },
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('transforms installation.id to number even when provided as string', () => {
    const payload = {
      action: 'created',
      installation: { id: '42' },
      sender: { id: 1 },
    };
    const result = githubWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.installation?.id).toBe(42);
      expect(typeof result.data.installation?.id).toBe('number');
    }
  });
});