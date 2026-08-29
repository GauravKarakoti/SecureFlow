import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Behaviour of the policy toggle server action (#660).
 */

let session: { user: { id: string } } | null = { user: { id: 'user-1' } };

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => session),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockUpsert = vi.hoisted(() => vi.fn());
const mockAuditCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => {
  const db: any = {
    $transaction: vi.fn(async (cb: any) => cb(db)),
    policyTemplate: { findUnique: mockFindUnique },
    userPolicyToggle: { upsert: mockUpsert },
    auditLog: { create: mockAuditCreate },
  };
  return { default: db };
});

import { togglePolicy } from './actions';
import { TOGGLE_ERRORS } from '@/lib/policies/toggle';
import { revalidatePath } from 'next/cache';

const TEMPLATE = { id: 'tpl-1', name: 'Block Hardcoded Secrets', severity: 'CRITICAL' };

beforeEach(() => {
  vi.clearAllMocks();
  session = { user: { id: 'user-1' } };
  mockFindUnique.mockResolvedValue(TEMPLATE);
  mockUpsert.mockResolvedValue({});
  mockAuditCreate.mockResolvedValue({});
});

describe('togglePolicy — desired state (#660)', () => {
  it('writes the state the caller asked for, not the inverse of a previous one', async () => {
    const result = await togglePolicy({ templateId: 'tpl-1', isActive: false });

    expect(result).toEqual({ ok: true, isActive: false });

    const args = mockUpsert.mock.calls[0][0];
    expect(args.update).toEqual({ isActive: false });
    expect(args.create).toMatchObject({
      userId: 'user-1',
      policyTemplateId: 'tpl-1',
      isActive: false,
    });
  });

  it('is idempotent — the same request twice lands on the same value', async () => {
    // The double-click case. The old action sent the previous state and wrote
    // !currentState, so two clicks before the revalidation landed wrote the
    // same value twice and the switch disagreed with the database.
    await togglePolicy({ templateId: 'tpl-1', isActive: true });
    await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(mockUpsert.mock.calls[0][0].update).toEqual({ isActive: true });
    expect(mockUpsert.mock.calls[1][0].update).toEqual({ isActive: true });
  });

  it('scopes the upsert to the signed-in user', async () => {
    await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(mockUpsert.mock.calls[0][0].where).toEqual({
      userId_policyTemplateId: { userId: 'user-1', policyTemplateId: 'tpl-1' },
    });
  });

  it('revalidates the policies page so the compiled rule set refreshes', async () => {
    await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/policies');
  });
});

describe('togglePolicy — failure modes (#660)', () => {
  it('reports an expired session instead of silently doing nothing', async () => {
    // `if (!session?.user?.id) return;` returned undefined, exactly like the
    // success path, so the optimistic switch stayed flipped and the user only
    // found out on reload.
    session = null;

    const result = await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(result).toEqual({ ok: false, error: TOGGLE_ERRORS.unauthenticated });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload before touching the database', async () => {
    const result = await togglePolicy({ isActive: true });

    expect(result).toEqual({ ok: false, error: TOGGLE_ERRORS.invalidInput });
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('returns a message for an unknown template rather than a foreign-key violation', async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await togglePolicy({ templateId: 'does-not-exist', isActive: true });

    expect(result).toEqual({ ok: false, error: TOGGLE_ERRORS.notFound });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('converts a database failure into a result the UI can render', async () => {
    mockUpsert.mockRejectedValue(new Error('deadlock detected'));

    const result = await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(result).toEqual({ ok: false, error: TOGGLE_ERRORS.failed });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('togglePolicy — audit trail (#660)', () => {
  it('records the change, which nothing did before', async () => {
    await togglePolicy({ templateId: 'tpl-1', isActive: false });

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate.mock.calls[0][0].data).toMatchObject({
      userId: 'user-1',
      action: 'POLICY_TOGGLE',
      resource: 'policy:Block Hardcoded Secrets',
      decision: 'DISABLED',
    });
  });

  it('records an enable as ENABLED', async () => {
    await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(mockAuditCreate.mock.calls[0][0].data.decision).toBe('ENABLED');
  });

  it('carries the rule name and severity, so the entry is readable on its own', async () => {
    await togglePolicy({ templateId: 'tpl-1', isActive: false });

    expect(mockAuditCreate.mock.calls[0][0].data.metadata).toMatchObject({
      policyTemplateId: 'tpl-1',
      policyName: 'Block Hardcoded Secrets',
      severity: 'CRITICAL',
      isActive: false,
    });
  });

  it('writes the toggle and the audit entry in one transaction', async () => {
    mockAuditCreate.mockRejectedValue(new Error('audit down'));

    const result = await togglePolicy({ templateId: 'tpl-1', isActive: true });

    // A rule change that cannot be recorded is not a rule change we want to
    // keep — this is the guardrail that gates pull requests.
    expect(result.ok).toBe(false);
  });

  it('writes no audit entry when the toggle itself failed', async () => {
    mockUpsert.mockRejectedValue(new Error('nope'));

    await togglePolicy({ templateId: 'tpl-1', isActive: true });

    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});
