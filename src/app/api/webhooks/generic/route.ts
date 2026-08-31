/**
 * Generic webhook route with HMAC-SHA256 signature verification.
 *
 * A second endpoint with its own secret, for a sender that should not share
 * credentials with `/api/webhooks`. The handler is the same module; only the
 * secret and the rate-limit bucket differ.
 *
 * Environment variables:
 *   GENERIC_WEBHOOK_SECRET - Shared HMAC secret for signature verification.
 */

import { withRateLimit } from '@/lib/middleware/rate-limit';
import { createInboundWebhookHandler } from '@/lib/webhooks/inbound-handler';

const handler = createInboundWebhookHandler({
  readSecret: () => process.env.GENERIC_WEBHOOK_SECRET,
  secretEnvVar: 'GENERIC_WEBHOOK_SECRET',
  logComponent: 'webhook-generic',
});

export const POST = withRateLimit(handler, {
  limit: 100,
  windowSeconds: 60,
  keyPrefix: 'webhook:generic',
});

export const dynamic = 'force-dynamic';
