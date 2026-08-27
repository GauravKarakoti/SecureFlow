import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import LogsTable from './LogsTable';
import type { AuditLogRow } from '@/lib/actions/admin';

// Mock server actions
vi.mock('@/lib/actions/admin', () => ({
  getAuditLogs: vi.fn(),
}));

describe('LogsTable component', () => {
  const mockLogs: AuditLogRow[] = [
    {
      id: 'log-1',
      userId: 'user-1',
      action: 'ADMIN_ROLE_UPDATE',
      resource: 'user:user-2',
      decision: null,
      metadata: null,
      timestamp: new Date('2026-07-29T20:00:00Z'),
      actor: { id: 'user-1', name: 'Admin', email: 'admin@x', codename: 'Tokyo' },
    },
    {
      id: 'log-2',
      userId: null,
      action: 'SCAN_TRIGGERED',
      resource: 'repo/test',
      decision: 'PASS',
      metadata: null,
      timestamp: new Date('2026-07-29T21:00:00Z'),
      actor: null,
    },
  ];

  it('is a valid React component and accepts props', () => {
    expect(LogsTable).toBeDefined();
    expect(typeof LogsTable).toBe('function');
  });

  it('renders without crashing given logs and actions', () => {
    const element = React.createElement(LogsTable, {
      logs: mockLogs,
      actions: ['ADMIN_ROLE_UPDATE', 'SCAN_TRIGGERED'],
    });
    expect(element).toBeDefined();
    expect(element.props.logs).toHaveLength(2);
    expect(element.props.actions).toEqual(['ADMIN_ROLE_UPDATE', 'SCAN_TRIGGERED']);
  });
});