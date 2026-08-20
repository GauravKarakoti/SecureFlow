import prisma from '@/lib/prisma';
import { projectWorkflowState, WorkflowState } from './projection';
import { z } from 'zod';

export const appendEventSchema = z.object({
  workflowId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.record(z.any()).default({}),
  actorId: z.string().optional(),
});

export async function appendEvent(
  workflowId: string,
  eventType: string,
  payload: Record<string, any> = {},
  actorId?: string
) {
  const data = appendEventSchema.parse({ workflowId, eventType, payload, actorId });

  return prisma.workflowEvent.create({
    data: {
      workflowId: data.workflowId,
      eventType: data.eventType,
      payload: data.payload,
      actorId: data.actorId,
    },
  });
}

export async function getWorkflowState(workflowId: string): Promise<WorkflowState> {
  const events = await prisma.workflowEvent.findMany({
    where: { workflowId },
    orderBy: { timestamp: 'asc' },
  });

  // Map the payload to 'any' since prisma stores JSON as Prisma.JsonValue
  const mappedEvents = events.map(event => ({
    eventType: event.eventType,
    payload: event.payload as any,
    timestamp: event.timestamp,
  }));

  return projectWorkflowState(workflowId, mappedEvents);
}
