import { NextResponse } from 'next/server';
import { resolveErrorStatus, DEFAULT_ERROR_STATUS } from './http-status';
import { scrubSensitiveData } from '@/lib/redaction';
import { logger } from '@/lib/logger';

/**
 * Backend logger.
 *
 * Was an inline object literal with two methods, no levels, no way to silence
 * it and no redaction -- and it wrote the raw error message, stack and Prisma
 * `meta` to stdout while scrubSensitiveData() protected only the response.
 * It now delegates to the shared logger in src/lib/logger.ts, which redacts
 * metadata recursively and gates on LOG_LEVEL (#563).
 *
 * Re-exported under the same name so existing callers are unaffected.
 */
export { logger };

// Standard custom error class for known operational/client errors
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number = 400, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;
    // Set the prototype explicitly to support instanceof checks in transpiled JS
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// Map HTTP status codes to standardized error names
const STATUS_TO_ERROR_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

// Scrub sensitive details such as paths, credentials, and connection strings.
//
// The implementation moved to src/lib/redaction.ts (#563) so the logger can
// share it without the two modules importing each other. Re-exported here
// unchanged, so every existing import keeps working.
export { scrubSensitiveData };

/**
 * Error class names we are willing to echo back to the client as an error code.
 *
 * Anything outside this list (`PrismaClientKnownRequestError`, `GenkitError`,
 * `TypeError`, …) tells a caller which libraries we run and how our internals
 * are wired, so those collapse to the generic status-derived code instead.
 */
const EXPOSABLE_ERROR_NAMES = new Set(['AppError', 'ValidationError']);

export function withErrorHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      // 1. Extract error details.
      //
      // The status is normalised rather than trusted: a thrown value can carry
      // a `status` that is not an HTTP status at all (Genkit uses string enums
      // such as 'FAILED_PRECONDITION'; WebSocket/undici use codes like 1006),
      // and handing one of those to NextResponse.json throws a RangeError from
      // inside this very handler. See src/lib/middleware/http-status.ts.
      const statusCode = resolveErrorStatus(err, DEFAULT_ERROR_STATUS);
      const originalMessage = err?.message || String(err);
      const stack = err?.stack;

      // Extract database / Prisma details if they exist
      const prismaCode = err?.code;
      const prismaMeta = err?.meta;

      // 2. Pipe the error context to the backend logger.
      //
      // We log named fields explicitly instead of spreading the error. `...err`
      // dragged in every own property the thrown object happened to carry —
      // including a Prisma `meta` holding query parameter values and any
      // request/response objects an HTTP client attached — which is how raw
      // credentials end up in log aggregation.
      logger.error("API route error caught by global handler", {
        error: {
          name: err?.name || 'Error',
          message: originalMessage,
          stack,
          code: prismaCode,
          meta: prismaMeta,
        },
        statusCode,
        rawStatus: err?.statusCode ?? err?.status ?? null,
      });

      // 3. Construct strict, standardized client error response
      let clientErrorCode = STATUS_TO_ERROR_CODE[statusCode] || 'INTERNAL_SERVER_ERROR';
      let clientMessage = "An unexpected error occurred. Incident logged.";

      // Determine if error should be redacted or not
      const isClientError = statusCode >= 400 && statusCode < 500;
      const isOperational = err?.isOperational === true;

      // If it's a client/operational error, we can safely expose the message
      if (isClientError || isOperational) {
        if (err?.name && EXPOSABLE_ERROR_NAMES.has(err.name)) {
          clientErrorCode = err.name;
        } else {
          clientErrorCode = STATUS_TO_ERROR_CODE[statusCode] || 'CLIENT_ERROR';
        }
        clientMessage = scrubSensitiveData(originalMessage);
      } else {
        // Redaction logic for unexpected server-side / system/ database errors
        const isPrisma = err?.name && err?.name.startsWith('Prisma');
        const isDatabase = isPrisma || (originalMessage && (
          originalMessage.toLowerCase().includes('postgres') ||
          originalMessage.toLowerCase().includes('postgresql') ||
          originalMessage.toLowerCase().includes('database') ||
          originalMessage.toLowerCase().includes('sql') ||
          originalMessage.toLowerCase().includes('prisma')
        ));

        if (isDatabase) {
          clientErrorCode = "DATABASE_ERROR";
          clientMessage = "A database error occurred. Connection or schema details redacted.";
        }
      }

      return NextResponse.json(
        {
          success: false,
          error: clientErrorCode,
          message: clientMessage,
        },
        { status: statusCode }
      );
    }
  };
}

