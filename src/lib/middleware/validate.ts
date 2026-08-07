import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export function withValidation<T>(
  schema: z.ZodType<T>,
  handler: (req: NextRequest, payload: T, ...args: any[]) => Promise<NextResponse>
) {
  return async (req: NextRequest, ...args: any[]) => {
    try {
      // We must clone the request so we don't consume the body if the handler needs the raw buffer
      const clonedReq = req.clone();
      const body = await clonedReq.json();

      const result = schema.safeParse(body);

      if (!result.success) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            message: 'Invalid request payload',
            details: result.error.issues,
          },
          { status: 400 }
        );
      }

      return handler(req, result.data, ...args);
    } catch (error) {
      return NextResponse.json(
        { error: 'Bad Request', message: 'Malformed JSON payload' },
        { status: 400 }
      );
    }
  };
}
