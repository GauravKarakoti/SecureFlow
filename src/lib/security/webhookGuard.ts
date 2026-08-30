/**
 * Webhook Guard — Next.js middleware for inbound webhook signature validation.
 *
 * Wraps a Next.js route handler to enforce:
 * 1. HMAC-SHA256 signature verification
 * 2. Timestamp-based replay protection (5-minute window)
 *
 * This module is the only caller of `admitWebhookRequest`, so it is where the
 * policy decisions live -- in particular the refusal to run at all without a
 * usable secret (#718). Node accepts an empty HMAC key, which means
 * `createHmac('sha256', '')` is an ordinary keyed digest that anyone can
 * compute; verifying against it admits every forged signature. A missing
 * secret is a deployment error, and it fails closed here rather than
 * degrading into an open endpoint.
 *
 * Usage:
 *   import { withWebhookGuard } from '@/lib/security/webhookGuard';
 *
 *   export const POST = withWebhookGuard(async (req, payload) => {
 *     // payload is the verified raw body -- the request stream is spent
 *   }, { secret: process.env.WEBHOOK_SECRET });
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  admitWebhookRequest,
  signPayload,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DEFAULT_REPLAY_WINDOW_SECONDS,
} from './hmacSigner';

export interface WebhookGuardOptions {
  /**
   * The HMAC secret for signature verification.
   *
   * May be a getter, which is read once per request so that a value supplied
   * from `process.env` resolves against the live environment rather than
   * whatever was set when the module was first imported.
   *
   * `undefined`, empty and whitespace-only are all treated as "not
   * configured": the guard answers 500 and the handler never runs.
   */
  secret: string | undefined;
  /** Signature header name (default: X-SecureFlow-Signature). */
  signatureHeader?: string;
  /** Timestamp header name (default: X-SecureFlow-Timestamp). */
  timestampHeader?: string;
  /** Replay window in seconds (default: 300 = 5 minutes). */
  replayWindowSeconds?: number;
  /** Custom error handler. */
  onError?: (error: { status: number; message: string }) => NextResponse;
}

/**
 * The response a guarded route gives when no secret is configured.
 *
 * 500, not 401: the caller did nothing wrong, and telling them to fix their
 * signature would send them chasing a problem that is on this side. The body
 * says only that the endpoint is misconfigured -- never which variable, and
 * never any part of the secret.
 */
const MISCONFIGURED = {
  status: 500,
  message: 'Webhook endpoint is not configured for signature verification',
} as const;

/**
 * Whether a secret is usable for HMAC.
 *
 * Whitespace-only counts as missing. A secret of `" "` almost always means an
 * env file with a trailing space on an otherwise empty assignment, and
 * treating it as real would key every signature off a single space character.
 */
export function isUsableSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.trim().length > 0;
}

/**
 * Create a webhook-guarded route handler.
 *
 * The guard:
 * - Refuses to run without a usable secret
 * - Reads the request body (required for signature verification)
 * - Validates the HMAC signature
 * - Checks the timestamp against the replay window
 * - Passes the verified payload to the handler as its second argument
 *
 * If any check fails, returns an appropriate HTTP error response.
 */
export function withWebhookGuard(
  handler: (req: NextRequest, payload: string) => Promise<NextResponse>,
  options: WebhookGuardOptions
) {
  const {
    signatureHeader = SIGNATURE_HEADER,
    timestampHeader = TIMESTAMP_HEADER,
    replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
    onError,
  } = options;

  const fail = (error: { status: number; message: string }): NextResponse =>
    onError ? onError(error) : NextResponse.json({ error: error.message }, { status: error.status });

  return async function guardedHandler(req: NextRequest): Promise<NextResponse> {
    // Read through the property rather than a value destructured above, so a
    // getter resolves against the environment as it is now. Destructuring at
    // wrapper-construction time would pin the value read at module load, which
    // in a serverless runtime is before the environment is necessarily
    // complete.
    const secret = options.secret;

    // Fail closed before any crypto runs. Verifying against an empty key is
    // not a weaker check, it is no check: the key is public, so any caller can
    // produce a digest that matches.
    if (!isUsableSecret(secret)) {
      return fail(MISCONFIGURED);
    }

    // Read the body first — signature is over the raw bytes
    const payload = await req.text();

    // Run admission checks
    const result = admitWebhookRequest(
      payload,
      secret,
      req.headers.get(signatureHeader),
      req.headers.get(timestampHeader),
      replayWindowSeconds
    );

    if (!result.ok) {
      return fail(result);
    }

    // All checks passed — forward to the handler along with the body it can no
    // longer read for itself.
    return handler(req, payload);
  };
}

/**
 * Generate headers for an outbound webhook request.
 *
 * Signs the payload and adds both the signature and timestamp headers.
 *
 * @param payload - The raw payload string.
 * @param secret - The shared HMAC secret. Must be non-blank.
 * @param extraHeaders - Additional headers to include.
 * @returns Headers object with signature and timestamp headers set.
 * @throws If `secret` is missing, empty or whitespace-only. Emitting a
 *   signature under a key we do not have would produce a delivery that looks
 *   authenticated and is not, which is worse for the receiver than no
 *   signature header at all.
 */
export function signOutboundWebhook(
  payload: string,
  secret: string | undefined,
  extraHeaders?: Record<string, string>
): Headers {
  if (!isUsableSecret(secret)) {
    throw new Error('Cannot sign an outbound webhook without a secret');
  }

  const headers = new Headers(extraHeaders);
  headers.set(SIGNATURE_HEADER, signPayload(payload, secret));
  headers.set(TIMESTAMP_HEADER, String(Math.floor(Date.now() / 1000)));
  headers.set('Content-Type', 'application/json');

  return headers;
}

/** What `verifyWebhookRequest` reports back. */
export type WebhookVerification =
  | { ok: true; payload: string; error: null }
  | { ok: false; payload: null; error: NextResponse };

/**
 * Verify a webhook request in a route handler.
 *
 * Returns the verified raw body on success, or the error response to return.
 *
 * The payload has to come back. `req.text()` spends the request's single-use
 * body stream, so before #718 a caller following the documented usage --
 * verify, then read the body -- got `''` or a throw on the *success* path, and
 * there was no correct way to call this function at all.
 *
 * Usage:
 *   const check = await verifyWebhookRequest(req, secret);
 *   if (!check.ok) return check.error;
 *   const event = JSON.parse(check.payload);
 */
export async function verifyWebhookRequest(
  req: NextRequest,
  secret: string | undefined,
  options?: {
    signatureHeader?: string;
    timestampHeader?: string;
    replayWindowSeconds?: number;
  }
): Promise<WebhookVerification> {
  const reject = (error: { status: number; message: string }): WebhookVerification => ({
    ok: false,
    payload: null,
    error: NextResponse.json({ error: error.message }, { status: error.status }),
  });

  if (!isUsableSecret(secret)) {
    return reject(MISCONFIGURED);
  }

  const payload = await req.text();

  const result = admitWebhookRequest(
    payload,
    secret,
    req.headers.get(options?.signatureHeader ?? SIGNATURE_HEADER),
    req.headers.get(options?.timestampHeader ?? TIMESTAMP_HEADER),
    options?.replayWindowSeconds
  );

  if (!result.ok) return reject(result);

  return { ok: true, payload, error: null };
}
