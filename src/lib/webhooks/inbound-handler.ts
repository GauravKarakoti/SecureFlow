/**
 * The shared body of an inbound generic webhook endpoint (#720).
 *
 * `/api/webhooks` and `/api/webhooks/generic` were the same file twice, copied
 * with the env var and the log prefix renamed. The copy that was not covered by
 * tests drifted immediately: both shipped with `keyPrefix: 'webhook:generic'`,
 * so they shared one rate-limit bucket. There is one implementation now, and
 * the routes differ only in the configuration they pass to it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withWebhookGuard } from '@/lib/security/webhookGuard';
import { withErrorHandler, AppError } from '@/lib/middleware/error-handler';
import { createLogger } from '@/lib/logger';

/** Events the endpoint answers specifically. Anything else is acknowledged. */
export type KnownWebhookEvent = 'ping' | 'alert' | 'notification';

export interface WebhookAck {
  status: string;
  message: string;
}

export interface InboundWebhookConfig {
  /** Reads the shared secret at request time, so a getter sees the live env. */
  readSecret: () => string | undefined;
  /** Name of the variable holding the secret, for the misconfiguration error. */
  secretEnvVar: string;
  /** `component` on every log record from this endpoint. */
  logComponent: string;
}

/**
 * Header names a sender may use to declare the event type, in precedence order.
 *
 * Falls back to an `event` property in the body when neither is present.
 */
const EVENT_HEADERS = ['x-webhook-event', 'x-event-type'] as const;

/**
 * Event names we will echo back or log verbatim.
 *
 * A sender controls this string, and it reaches a log line and a JSON
 * response. Anything unrecognised is reported as `unknown` rather than
 * reflected, so a crafted header cannot inject newlines into the log or
 * arbitrary text into the acknowledgement.
 */
const KNOWN_EVENTS = new Set<string>(['ping', 'alert', 'notification']);

/** The longest event name we will consider before giving up on it. */
const MAX_EVENT_LENGTH = 64;

/**
 * Resolve the event type from the headers, then the body.
 *
 * Returns `null` when nothing usable was supplied.
 */
export function resolveEventType(
  headers: Headers,
  payload: Record<string, unknown>
): string | null {
  for (const name of EVENT_HEADERS) {
    const value = headers.get(name);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  const fromBody = payload.event;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();

  return null;
}

/**
 * The event name as it is safe to log and echo.
 *
 * Known events pass through; everything else -- including an over-long or
 * whitespace-laden header -- becomes `unknown`.
 */
export function safeEventLabel(event: string | null): string {
  if (!event) return 'unknown';
  if (event.length > MAX_EVENT_LENGTH) return 'unknown';
  return KNOWN_EVENTS.has(event) ? event : 'unknown';
}

/**
 * Describe a payload for a log line: its shape, never its values.
 *
 * A verified signature says the body came from someone holding the secret. It
 * does not say the body is safe to print, and alert payloads from real
 * providers carry tokens, callback URLs with credentials in the query string
 * and customer identifiers. The `default:` branch of the original
 * `processPayload` already logged only `Object.keys(payload)`; the `alert` and
 * `notification` branches printed the whole object with `console.log`, which
 * also bypassed the level gate and the redaction in `@/lib/logger` (#563).
 *
 * Keys are capped so a payload with ten thousand of them cannot itself become
 * the log flood.
 */
export function describePayload(payload: Record<string, unknown>): {
  keys: string[];
  keyCount: number;
  truncatedKeys: boolean;
} {
  const keys = Object.keys(payload);
  const MAX_KEYS = 25;

  return {
    keys: keys.slice(0, MAX_KEYS),
    keyCount: keys.length,
    truncatedKeys: keys.length > MAX_KEYS,
  };
}

/**
 * Decide the acknowledgement for a verified payload.
 *
 * Extend this to handle specific event types from your webhook providers.
 */
export function processPayload(
  payload: Record<string, unknown>,
  event: string | null,
  log: ReturnType<typeof createLogger>
): WebhookAck {
  const label = safeEventLabel(event);

  switch (label) {
    case 'ping':
      return { status: 'pong', message: 'Webhook verified' };

    case 'alert':
      log.info('Alert received', { event: label, ...describePayload(payload) });
      return { status: 'received', message: 'Alert processed' };

    case 'notification':
      log.info('Notification received', { event: label, ...describePayload(payload) });
      return { status: 'received', message: 'Notification processed' };

    default:
      log.info('Webhook received', { event: label, ...describePayload(payload) });
      return { status: 'received', message: 'Webhook acknowledged' };
  }
}

/**
 * Build the POST handler for a generic inbound webhook endpoint.
 *
 * The caller wraps the result in `withRateLimit` with a prefix of its own --
 * deliberately not defaulted here, because a shared default is the bug this
 * module exists to remove.
 */
export function createInboundWebhookHandler(config: InboundWebhookConfig) {
  const log = createLogger({ context: { component: config.logComponent } });

  return withErrorHandler(
    withWebhookGuard(
      async function POST(req: NextRequest, payload: string): Promise<NextResponse> {
        if (!config.readSecret()) {
          throw new AppError(`${config.secretEnvVar} is not set`, 500, false);
        }

        let parsed: Record<string, unknown>;
        try {
          const value = JSON.parse(payload);
          // `JSON.parse` accepts `null`, `7` and `"a"`. `Object.keys` on any of
          // those is fine, but `parsed.event` on a string returns a character,
          // so reject anything that is not a plain object up front.
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new SyntaxError('not an object');
          }
          parsed = value as Record<string, unknown>;
        } catch {
          throw new AppError('Request body is not valid JSON', 400);
        }

        const event = resolveEventType(req.headers, parsed);

        return NextResponse.json(processPayload(parsed, event, log), { status: 200 });
      },
      {
        get secret() {
          return config.readSecret() ?? '';
        },
      }
    )
  );
}
