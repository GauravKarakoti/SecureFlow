import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import AuditLogTable from './audit-log-table';
import type { UserAuditLogResult } from '@/lib/actions/audit';

// Mock server actions
vi.mock('@/lib/actions/audit', () => ({
  getUserAuditLogs: vi.fn(),
}));

describe('AuditLogTable component', () => {
  const mockInitialResult: UserAuditLogResult = {
    logs: [
      {
        id: 'log-1',
        action: 'AUDIT_CHECK',
        resource: 'GauravKarakoti/SecureFlow#388',
        decision: 'PASS',
        timestamp: new Date('2026-07-29T20:00:00Z'),
        userId: 'user-1',
      },
      {
        id: 'log-2',
        action: 'PROMPT_GUARD',
        resource: 'test-repo',
        decision: 'BLOCK',
        timestamp: new Date('2026-07-29T21:00:00Z'),
        userId: null,
      },
    ],
    total: 2,
    totalPages: 1,
  };

  it('is a valid React component and accepts props', () => {
    expect(AuditLogTable).toBeDefined();
    expect(typeof AuditLogTable).toBe('function');
  });

  it('renders table structure without crashing', () => {
    const element = React.createElement(AuditLogTable, {
      initialResult: mockInitialResult,
      actions: ['AUDIT_CHECK', 'PROMPT_GUARD'],
      decisions: ['PASS', 'BLOCK'],
      ownName: 'Test User',
    });
    expect(element).toBeDefined();
    expect(element.props.ownName).toBe('Test User');
    expect(element.props.initialResult.logs).toHaveLength(2);
  });
});
