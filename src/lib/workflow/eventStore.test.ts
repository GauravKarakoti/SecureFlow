import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appendEvent, getWorkflowState } from './eventStore';
import { projectWorkflowState, initialWorkflowState } from './projection';
import prisma from '@/lib/prisma';

vi.mock('@/lib/prisma', () => ({
  default: {
    workflowEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe('Event Sourcing: Projection', () => {
  it('correctly projects WorkflowStarted event', () => {
    const events = [
      { eventType: 'WorkflowStarted', payload: { foo: 'bar' }, timestamp: new Date('2026-01-01T00:00:00Z') },
    ];
    const state = projectWorkflowState('wf-1', events);
    
    expect(state.workflowId).toBe('wf-1');
    expect(state.status).toBe('STARTED');
    expect(state.data.foo).toBe('bar');
    expect(state.history.length).toBe(1);
    expect(state.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('correctly projects multiple events in chronological order', () => {
    const events = [
      { eventType: 'WorkflowStarted', payload: { init: true }, timestamp: new Date('2026-01-01T00:00:00Z') },
      { eventType: 'CustomStep', payload: { step: 1 }, timestamp: new Date('2026-01-01T01:00:00Z') },
      { eventType: 'ApprovalGranted', payload: { approver: 'admin' }, timestamp: new Date('2026-01-01T02:00:00Z') },
    ];
    
    const state = projectWorkflowState('wf-2', events);
    
    expect(state.status).toBe('APPROVED');
    expect(state.data.init).toBe(true);
    expect(state.data.step).toBe(1);
    expect(state.data.approver).toBe('admin');
    expect(state.history.length).toBe(3);
    expect(state.updatedAt).toEqual(new Date('2026-01-01T02:00:00Z'));
  });
});

describe('Event Sourcing: Store integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends an event successfully', async () => {
    vi.mocked(prisma.workflowEvent.create).mockResolvedValueOnce({
      id: 'event-1',
      workflowId: 'wf-3',
      eventType: 'WorkflowStarted',
      payload: {},
      actorId: null,
      timestamp: new Date(),
    });

    await appendEvent('wf-3', 'WorkflowStarted');

    expect(prisma.workflowEvent.create).toHaveBeenCalledWith({
      data: {
        workflowId: 'wf-3',
        eventType: 'WorkflowStarted',
        payload: {},
        actorId: undefined,
      }
    });
  });

  it('retrieves and projects workflow state from db', async () => {
    const dbEvents = [
      { id: '1', workflowId: 'wf-4', eventType: 'WorkflowStarted', payload: {}, actorId: null, timestamp: new Date('2026-01-01T00:00:00Z') },
      { id: '2', workflowId: 'wf-4', eventType: 'ApprovalDenied', payload: { reason: 'bad' }, actorId: 'u-1', timestamp: new Date('2026-01-01T00:01:00Z') },
    ];
    
    vi.mocked(prisma.workflowEvent.findMany).mockResolvedValueOnce(dbEvents);

    const state = await getWorkflowState('wf-4');
    
    expect(prisma.workflowEvent.findMany).toHaveBeenCalledWith({
      where: { workflowId: 'wf-4' },
      orderBy: { timestamp: 'asc' },
    });
    
    expect(state.status).toBe('REJECTED');
    expect(state.data.reason).toBe('bad');
  });
});
