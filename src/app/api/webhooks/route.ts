/**
 * Generic webhook route with HMAC-SHA256 signature verification.
 *
 * The endpoint specified in issue #539. It accepts inbound webhooks from any
 * source that signs payloads with HMAC-SHA256 and validates:
 *
 * 1. Signature (X-SecureFlow-Signature)
 * 2. Timestamp (X-SecureFlow-Timestamp: unix epoch seconds)
 * 3. Replay window (5-minute tolerance)
 *
 * The handler itself is shared with `/api/webhooks/generic` -- see
 * `@/lib/webhooks/inbound-handler`. The two routes differ only in the secret
 * they read and the rate-limit bucket they draw from.
 *
 * Environment variables:
 *   WEBHOOK_SECRET - Shared HMAC secret for signature verification.
 */

import { withRateLimit } from '@/lib/middleware/rate-limit';
import { createInboundWebhookHandler } from '@/lib/webhooks/inbound-handler';

const handler = createInboundWebhookHandler({
  readSecret: () => process.env.WEBHOOK_SECRET,
  secretEnvVar: 'WEBHOOK_SECRET',
  logComponent: 'webhook-default',
});

export const POST = withRateLimit(handler, {
  limit: 100,
  windowSeconds: 60,
  // Distinct from `/api/webhooks/generic`. Both routes shipped with
  // `webhook:generic`, and `withRateLimit` keys on
  // `rate-limit:${keyPrefix}:${ip}` -- so traffic to either endpoint spent the
  // other's budget (#720).
  keyPrefix: 'webhook:default',
});

export const dynamic = 'force-dynamic';
