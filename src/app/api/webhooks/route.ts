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
 *   WEBHOOK_MAX_BYTES - Largest body accepted, in bytes (default 1 MiB).
 *   WEBHOOK_ALLOW_UNBOUND_LEGACY_SIGNATURES - "true" to also accept a legacy
 *     sha256= digest over the bare body. Off by default; see hmacSigner.ts.
 */

import { withRateLimit } from "@/lib/middleware/rate-limit";
import { createInboundWebhookHandler } from "@/lib/webhooks/inbound-handler";
import { withDeprecation } from "@/lib/api/deprecation";

const handler = createInboundWebhookHandler({
  readSecret: () => process.env.WEBHOOK_SECRET,
  secretEnvVar: "WEBHOOK_SECRET",
  logComponent: "webhook-default",
});

export const POST = withDeprecation(
  withRateLimit(handler, {
    limit: 100,
    windowSeconds: 60,
    // Distinct from `/api/webhooks/generic`. Both routes shipped with
    // `webhook:generic`, and `withRateLimit` keys on
    // `rate-limit:${keyPrefix}:${ip}` -- so traffic to either endpoint spent the
    // other's budget (#720).
    keyPrefix: "webhook:default",
  }),
  {
    deprecatedAt: new Date("2026-11-01T00:00:00Z"),
    sunsetAt: new Date("2027-05-01T00:00:00Z"),
    successorUrl: "/api/webhooks/generic",
  }
);

export const dynamic = "force-dynamic";
