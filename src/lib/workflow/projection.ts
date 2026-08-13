export interface WorkflowState {
  workflowId: string;
  status: 'PENDING' | 'STARTED' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
  data: Record<string, any>;
  history: Array<{ type: string; timestamp: Date }>;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export const initialWorkflowState = (workflowId: string): WorkflowState => ({
  workflowId,
  status: 'PENDING',
  data: {},
  history: [],
  createdAt: null,
  updatedAt: null,
});

export function projectWorkflowState(
  workflowId: string,
  events: Array<{ eventType: string; payload: any; timestamp: Date }>
): WorkflowState {
  return events.reduce((state, event) => {
    const newState = { ...state };
    newState.history.push({ type: event.eventType, timestamp: event.timestamp });
    newState.updatedAt = event.timestamp;

    if (!newState.createdAt) {
      newState.createdAt = event.timestamp;
    }

    switch (event.eventType) {
      case 'WorkflowStarted':
        newState.status = 'STARTED';
        newState.data = { ...newState.data, ...event.payload };
        break;
      case 'ApprovalGranted':
        newState.status = 'APPROVED';
        newState.data = { ...newState.data, ...event.payload };
        break;
      case 'ApprovalDenied':
        newState.status = 'REJECTED';
        newState.data = { ...newState.data, ...event.payload };
        break;
      case 'WorkflowCompleted':
        newState.status = 'COMPLETED';
        newState.data = { ...newState.data, ...event.payload };
        break;
      default:
        // Handle unmapped events by just storing their payload loosely
        newState.data = { ...newState.data, ...event.payload };
        break;
    }

    return newState;
  }, initialWorkflowState(workflowId));
}
