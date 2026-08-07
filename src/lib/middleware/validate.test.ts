import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { withValidation } from './validate';

// ---- Helper: build a minimal NextRequest stub ----
function makeRequest(body: unknown, contentType = 'application/json') {
  const bodyStr = JSON.stringify(body);
  return {
    clone: () => makeRequest(body, contentType),
    json: async () => JSON.parse(bodyStr),
    headers: { get: (k: string) => (k === 'content-type' ? contentType : null) },
  } as any;
}

describe('withValidation middleware wrapper', () => {
  const testSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it('passes validated data to the inner handler when payload is valid', async () => {
    const handler = vi.fn(async (_req: any, payload: any) =>
      NextResponse.json({ received: payload }, { status: 200 })
    );

    const wrapped = withValidation(testSchema, handler);
    const req = makeRequest({ name: 'Alice', age: 30 });
    const res = await wrapped(req);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    // The handler should receive the parsed (and validated) payload.
    expect(handler).toHaveBeenCalledWith(req, { name: 'Alice', age: 30 });
  });

  it('returns 400 with validation issues when payload is invalid', async () => {
    const handler = vi.fn();
    const wrapped = withValidation(testSchema, handler);

    // age is missing, name is empty
    const req = makeRequest({ name: '', age: -1 });
    const res = await wrapped(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBe('Invalid request payload');
    expect(body.details).toBeDefined();
    expect(body.details.length).toBeGreaterThan(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 with detail issues when zod finds multiple failures', async () => {
    const handler = vi.fn();
    const wrapped = withValidation(testSchema, handler);

    // both fields wrong
    const req = makeRequest({ name: 123, age: 'not-a-number' });
    const res = await wrapped(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.length).toBeGreaterThanOrEqual(2);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body is malformed JSON', async () => {
    const handler = vi.fn();
    const wrapped = withValidation(testSchema, handler);

    // Override json() to throw a SyntaxError
    const badReq = {
      clone: () => badReq,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      headers: { get: () => 'application/json' },
    } as any;

    const res = await wrapped(badReq);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('Malformed JSON payload');
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards additional positional arguments to the handler', async () => {
    const handler = vi.fn(async (_req: any, _payload: any, extra: string) =>
      NextResponse.json({ extra }, { status: 200 })
    );

    const wrapped = withValidation(testSchema, handler);
    const req = makeRequest({ name: 'Bob', age: 25 });
    const res = await wrapped(req, 'extra-arg');

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(req, { name: 'Bob', age: 25 }, 'extra-arg');
  });

  it('works correctly with an empty object schema', async () => {
    const emptySchema = z.object({});
    const handler = vi.fn(async () => NextResponse.json({ ok: true }, { status: 200 }));

    const wrapped = withValidation(emptySchema, handler);
    const req = makeRequest({ unexpected: 'field' });
    const res = await wrapped(req);

    // An empty schema will strip unknown fields by default in Zod…
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});