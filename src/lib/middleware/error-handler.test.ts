import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { withErrorHandler, AppError, scrubSensitiveData } from './error-handler';

// Mock NextResponse.json to check returned response structure and status code
vi.mock('next/server', () => {
  return {
    NextResponse: {
      json: vi.fn((body, init) => {
        return {
          body,
          status: init?.status || 200,
        };
      }),
    },
  };
});

describe('scrubSensitiveData', () => {
  it('passes safe/normal string without change', () => {
    const input = 'Invalid GitHub webhook signature';
    expect(scrubSensitiveData(input)).toBe(input);
  });

  it('redacts connection strings', () => {
    const input = 'Could not connect to postgresql://postgres:secretpassword@localhost:5432/secureflow';
    expect(scrubSensitiveData(input)).toBe('Could not connect to [REDACTED_CONNECTION_STRING]');
  });

  it('redacts windows path structure', () => {
    const input = 'Error occurred in D:\\Struggle\\Open Source\\SecureFlow\\src\\app\\api\\route.ts';
    expect(scrubSensitiveData(input)).toBe('Error occurred in [REDACTED_PATH]');
  });

  it('redacts unix path structure', () => {
    const input = 'Error occurred in /usr/local/bin/node/app/route.ts';
    expect(scrubSensitiveData(input)).toBe('Error occurred in [REDACTED_PATH]');
  });

  it('redacts environmental secrets', () => {
    const input = 'Failed load: GITHUB_CLIENT_SECRET=mysecretkey123';
    expect(scrubSensitiveData(input)).toBe('Failed load: [REDACTED_SECRET]');
  });
});

describe('withErrorHandler middleware wrapper', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('successfully returns the result of the handler if no error is thrown', async () => {
    const mockResponse = { success: true, data: 'OK' };
    const handler = async () => mockResponse;
    const wrapped = withErrorHandler(handler);

    const result = await wrapped();
    expect(result).toBe(mockResponse);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('handles AppError (operational/client) correctly', async () => {
    const handler = async () => {
      throw new AppError('Custom client error message', 400);
    };
    const wrapped = withErrorHandler(handler);

    const result = (await wrapped()) as { status: number };

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        success: false,
        error: 'AppError',
        message: 'Custom client error message',
      },
      { status: 400 }
    );
    expect(result.status).toBe(400);
  });

  it('handles custom errors with status codes < 500 without redacting message', async () => {
    const handler = async () => {
      const err = new Error('Invalid signature') as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    };
    const wrapped = withErrorHandler(handler);

    const result = (await wrapped()) as { status: number };

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid signature',
      },
      { status: 401 }
    );
    expect(result.status).toBe(401);
  });

  it('redacts database internal error details on 500 error', async () => {
    const handler = async () => {
      const err = new Error('Prisma query failed: SELECT * FROM User WHERE codename = ...') as Error & { name: string; code: string };
      err.name = 'PrismaClientKnownRequestError';
      err.code = 'P2002';
      throw err;
    };
    const wrapped = withErrorHandler(handler);

    const result = (await wrapped()) as { status: number };

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        success: false,
        error: 'DATABASE_ERROR',
        message: 'A database error occurred. Connection or schema details redacted.',
      },
      { status: 500 }
    );
    expect(result.status).toBe(500);
  });

  it('redacts generic internal server error details', async () => {
    const handler = async () => {
      throw new Error('Something went horribly wrong internally with private API key abc123');
    };
    const wrapped = withErrorHandler(handler);

    const result = (await wrapped()) as { status: number };

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred. Incident logged.',
      },
      { status: 500 }
    );
    expect(result.status).toBe(500);
  });
});
