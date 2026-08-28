/**
 * Webhook Guard — Next.js middleware for inbound webhook signature validation.
 *
 * Wraps a Next.js route handler to enforce:
 * 1. HMAC-SHA256 signature verification
 * 2. Timestamp-based replay protection (5-minute window)
 *
 * Usage:
 *   import { withWebhookGuard } from '@/lib/security/webhookGuard';
 *
 *   export const POST = withWebhookGuard(async (req) => {
 *     const payload = await req.text();
 *     // payload is verified — process it
 *   }, { secret: process.env.WEBHOOK_SECRET });
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  admitWebhookRequest,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DEFAULT_REPLAY_WINDOW_SECONDS,
} from './hmacSigner';

export interface WebhookGuardOptions {
  /** The HMAC secret for signature verification. */
  secret: string;
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
 * Create a webhook-guarded route handler.
 *
 * The guard:
 * - Reads the request body (required for signature verification)
 * - Validates the HMAC signature
 * - Checks the timestamp against the replay window
 * - Passes the verified payload to the handler via `req.text()`
 *
 * If any check fails, returns an appropriate HTTP error response.
 */
export function withWebhookGuard(
  handler: (req: NextRequest, payload: string) => Promise<NextResponse>,
  options: WebhookGuardOptions
) {
  const {
    secret,
    signatureHeader = SIGNATURE_HEADER,
    timestampHeader = TIMESTAMP_HEADER,
    replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
    onError,
  } = options;

  return async function guardedHandler(req: NextRequest): Promise<NextResponse> {
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
      if (onError) {
        return onError(result);
      }

      return NextResponse.json(
        { error: result.message },
        { status: result.status }
      );
    }

    // All checks passed — forward to the handler
    return handler(req, payload);
  };
}

/**
 * Generate headers for an outbound webhook request.
 *
 * Signs the payload and adds both the signature and timestamp headers.
 *
 * @param payload - The raw payload string.
 * @param secret - The shared HMAC secret.
 * @param extraHeaders - Additional headers to include.
 * @returns Headers object with signature and timestamp headers set.
 */
export function signOutboundWebhook(
  payload: string,
  secret: string,
  extraHeaders?: Record<string, string>
): Headers {
  const headers = new Headers(extraHeaders);
  headers.set(SIGNATURE_HEADER, signPayload(payload, secret));
  headers.set(TIMESTAMP_HEADER, Math.floor(Date.now() / 1000).toString());
  headers.set('Content-Type', 'application/json');

  return headers;
}

/**
 * Quick helper to verify a webhook request in a route handler.
 *
 * Returns `null` on success, or a `NextResponse` error on failure.
 *
 * Usage:
 *   const error = await verifyWebhookRequest(req, secret);
 *   if (error) return error;
 *   // ... process verified request
 */
export async function verifyWebhookRequest(
  req: NextRequest,
  secret: string,
  options?: {
    signatureHeader?: string;
    timestampHeader?: string;
    replayWindowSeconds?: number;
  }
): Promise<NextResponse | null> {
  const payload = await req.text();

  const result = admitWebhookRequest(
    payload,
    secret,
    req.headers.get(options?.signatureHeader ?? SIGNATURE_HEADER),
    req.headers.get(options?.timestampHeader ?? TIMESTAMP_HEADER),
    options?.replayWindowSeconds
  );

  if (result.ok) return null;

  return NextResponse.json(
    { error: result.message },
    { status: result.status }
  );
}
