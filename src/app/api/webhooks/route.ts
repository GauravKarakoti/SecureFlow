/**
 * Generic webhook route with HMAC-SHA256 signature verification.
 *
 * This is the webhook endpoint specified in Issue #539. It accepts inbound
 * webhooks from any source that signs payloads with HMAC-SHA256 and validates:
 *
 * 1. Signature (X-SecureFlow-Signature: sha256=<hex>)
 * 2. Timestamp (X-SecureFlow-Timestamp: unix epoch seconds)
 * 3. Replay window (5-minute tolerance)
 *
 * Environment variables:
 *   WEBHOOK_SECRET - Shared HMAC secret for signature verification.
 *
 * Headers expected from senders:
 *   X-SecureFlow-Signature: sha256=<hex digest>
 *   X-SecureFlow-Timestamp: <unix epoch seconds>
 */

import { NextRequest, NextResponse } from 'next/server';
import { withWebhookGuard } from '@/lib/security/webhookGuard';
import { withRateLimit } from '@/lib/middleware/rate-limit';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';

/**
 * Process a verified webhook payload.
 *
 * Extend this function to handle specific event types from your webhook providers.
 */
async function processPayload(
  payload: Record<string, unknown>,
  event?: string
): Promise<{ status: string; message: string }> {
  switch (event) {
    case 'ping':
      return { status: 'pong', message: 'Webhook verified' };

    case 'alert':
      console.log('[WEBHOOK] Alert received:', payload);
      return { status: 'received', message: 'Alert processed' };

    case 'notification':
      console.log('[WEBHOOK] Notification received:', payload);
      return { status: 'received', message: 'Notification processed' };

    default:
      console.log('[WEBHOOK] Received payload:', {
        event: event ?? 'unknown',
        keys: Object.keys(payload),
      });
      return { status: 'received', message: 'Webhook acknowledged' };
  }
}

const handler = withErrorHandler(
  withWebhookGuard(
    async function POST(req: NextRequest, payload: string): Promise<NextResponse> {
      const secret = process.env.WEBHOOK_SECRET;
      if (!secret) {
        throw new AppError('WEBHOOK_SECRET is not set', 500, false);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new AppError('Request body is not valid JSON', 400);
      }

      // Extract event type from common header patterns
      const event =
        req.headers.get('x-webhook-event') ??
        req.headers.get('x-event-type') ??
        (typeof parsed.event === 'string' ? parsed.event : undefined);

      const result = await processPayload(parsed, event);

      return NextResponse.json(result, { status: 200 });
    },
    {
      get secret() {
        return process.env.WEBHOOK_SECRET ?? '';
      },
    }
  )
);

export const POST = withRateLimit(handler, {
  limit: 100,
  windowSeconds: 60,
  keyPrefix: 'webhook:generic',
});

export const dynamic = 'force-dynamic';
