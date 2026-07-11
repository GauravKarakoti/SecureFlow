import { NextResponse } from 'next/server';

// Standard backend logger
export const logger = {
  error: (message: string, meta?: Record<string, unknown>) => {
    const logOutput = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message,
      ...meta,
    };
    console.error(`[Backend Logger] ${JSON.stringify(logOutput)}`);
  },
  info: (message: string, meta?: Record<string, unknown>) => {
    const logOutput = {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message,
      ...meta,
    };
    console.info(`[Backend Logger] ${JSON.stringify(logOutput)}`);
  }
};

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

// Scrub sensitive details such as paths, credentials, and connection strings
export function scrubSensitiveData(text: string): string {
  if (!text) return text;
  let sanitized = text;

  // Redact PostgreSQL / Database connection URLs (e.g., postgresql://username:password@host/db)
  sanitized = sanitized.replace(/[a-zA-Z]+:\/\/[^/\s]+:[^/\s]+@[^\s]+/g, '[REDACTED_CONNECTION_STRING]');

  // Redact potential passwords/keys in connection strings
  sanitized = sanitized.replace(/:\/\/[^@]+@/g, '://[REDACTED_CREDENTIALS]@');

  // Redact file paths (both Windows and Unix paths)
  // Windows paths: e.g. D:\Struggle\Open Source\SecureFlow\...
  sanitized = sanitized.replace(/[a-zA-Z]:\\[\\\w\s.-]+/g, '[REDACTED_PATH]');
  // Unix paths: e.g. /usr/local/bin/...
  sanitized = sanitized.replace(/\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g, '[REDACTED_PATH]');

  // Redact potential environment variable patterns (e.g. GITHUB_CLIENT_SECRET=...)
  sanitized = sanitized.replace(/[\w.-]*(?:key|secret|token|password|auth|db_url|database_url)[\w.-]*\s*=\s*[^\s]+/gi, '[REDACTED_SECRET]');

  return sanitized;
}

export function withErrorHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      // 1. Extract error details
      const statusCode = err?.statusCode || err?.status || 500;
      const originalMessage = err?.message || String(err);
      const stack = err?.stack;

      // Extract database / Prisma details if they exist
      const prismaCode = err?.code;
      const prismaMeta = err?.meta;

      // 2. Pipe the full, unredacted context to the backend logger
      logger.error("API route error caught by global handler", {
        error: {
          name: err?.name || 'Error',
          message: originalMessage,
          stack,
          code: prismaCode,
          meta: prismaMeta,
          ...err
        },
        statusCode,
      });

      // 3. Construct strict, standardized client error response
      let clientErrorCode = STATUS_TO_ERROR_CODE[statusCode] || 'INTERNAL_SERVER_ERROR';
      let clientMessage = "An unexpected error occurred. Incident logged.";

      // Determine if error should be redacted or not
      const isClientError = statusCode >= 400 && statusCode < 500;
      const isOperational = err?.isOperational === true;

      // If it's a client/operational error, we can safely expose the message
      if (isClientError || isOperational) {
        if (err?.name && err?.name !== 'Error') {
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

