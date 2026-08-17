/**
 * Admission control for the GitHub webhook endpoint (#562).
 *
 * `src/app/api/webhooks/github/route.ts` is the only untrusted-input entry point
 * in the application, and it carried four problems that this module exists to
 * fix. Each one is documented at the function that addresses it.
 *
 * Everything here is pure and takes its inputs as arguments — no `NextRequest`,
 * no `process.env` inside the checks — so every branch is unit-testable without
 * constructing a request or standing up a queue. Same shape as
 * `src/lib/client-ip.ts` and `src/lib/middleware/http-status.ts`.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Events the worker knows how to process. Anything else is acknowledged and dropped. */
export const TRACKED_EVENTS = [
  'pull_request',
  'installation',
  'installation_repositories',
] as const;

export type TrackedEvent = (typeof TRACKED_EVENTS)[number];

/**
 * Default body cap: 5 MB.
 *
 * GitHub's own limit is 25 MB, but nothing this app processes comes close — the
 * largest realistic delivery is an `installation_repositories` payload listing a
 * few hundred repositories. See {@link isPayloadTooLarge} for why an unbounded
 * read is a problem here specifically.
 */
export const DEFAULT_MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

/** A `sha256=` header carries exactly 64 hex characters. */
const SIGNATURE_HEX_LENGTH = 64;
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Extract the hex digest from an `x-hub-signature-256` header.
 *
 * Validates the shape strictly rather than just stripping the prefix. The old
 * implementation passed whatever followed `sha256=` to `Buffer.from(value,
 * 'hex')`, and that function silently truncates at the first non-hex character:
 * `sha256=zz` becomes a zero-length buffer. The length comparison that followed
 * caught that particular case, but relying on a downstream length check to
 * compensate for an unvalidated parse is exactly the kind of thing that breaks
 * when the downstream check is refactored.
 *
 * Returns `null` for anything that is not a well-formed signature.
 */
export function parseGithubSignature(signatureHeader: string | null | undefined): string | null {
  if (typeof signatureHeader !== 'string') return null;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return null;

  const hex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (hex.length !== SIGNATURE_HEX_LENGTH) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  return hex.toLowerCase();
}

/**
 * Constant-time signature check.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, so the length
 * is compared first. Both operands are fixed-length SHA-256 digests by the time
 * they get here, so that guard is belt-and-braces rather than a leak.
 */
export function verifySignature(
  payloadText: string,
  secret: string,
  signatureHex: string
): boolean {
  const digest = createHmac('sha256', secret).update(payloadText, 'utf8').digest('hex');

  const provided = Buffer.from(signatureHex, 'hex');
  const expected = Buffer.from(digest, 'hex');

  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

/** Read `GITHUB_WEBHOOK_MAX_BYTES`, falling back to the default for junk values. */
export function parseMaxWebhookBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_WEBHOOK_BYTES;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_WEBHOOK_BYTES;

  return parsed;
}

/**
 * Decide whether a body is too large to accept.
 *
 * The route previously did `await req.text()` with no cap at all, buffering the
 * whole body into memory *before* anything was checked. The endpoint's rate
 * limit is 50 requests per minute per IP, so one source could make the process
 * buffer roughly 1.25 GB per minute of unverified bytes — and because HMAC
 * verification happened after the full read, the attacker did not even need a
 * valid signature to make us pay for it. On a memory-capped container that is a
 * trivial OOM.
 *
 * `Content-Length` is attacker-supplied, so this is called twice: once on the
 * header to reject cheaply, and once on the real byte length after reading, in
 * case the header lied. A missing or unparseable header is not treated as a
 * rejection — chunked requests legitimately omit it — which is exactly why the
 * post-read check has to exist.
 */
export function isPayloadTooLarge(
  reportedLength: string | number | null | undefined,
  maxBytes: number = DEFAULT_MAX_WEBHOOK_BYTES
): boolean {
  if (reportedLength === null || reportedLength === undefined) return false;

  const parsed =
    typeof reportedLength === 'number' ? reportedLength : Number(String(reportedLength).trim());

  if (!Number.isFinite(parsed) || parsed < 0) return false;

  return parsed > maxBytes;
}

/** Byte length of a payload, which is what the cap is expressed in. */
export function payloadByteLength(payloadText: string): number {
  return Buffer.byteLength(payloadText, 'utf8');
}

export type WebhookPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Parse a verified body into an object.
 *
 * The route used to call `JSON.parse(rawPayloadText)` inline. A body that passes
 * HMAC verification but is not valid JSON throws a bare `SyntaxError`, which
 * carries no `statusCode`, so `resolveErrorStatus` fell through to
 * `DEFAULT_ERROR_STATUS` — **500**. GitHub treats 5xx as retryable and
 * re-delivers a payload that can never succeed, and the failure surfaces in our
 * logs as an unexplained server fault rather than as the client error it is.
 *
 * Returns a discriminated result instead of throwing so the caller decides the
 * status code, and rejects a non-object body (`"null"`, `"[]"`, `"42"` are all
 * valid JSON) since every downstream consumer indexes into it.
 */
export function parseWebhookPayload(payloadText: string): WebhookPayloadResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return { ok: false, reason: 'Request body is not valid JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'Request body must be a JSON object' };
  }

  return { ok: true, payload: parsed as Record<string, unknown> };
}

/** True for an event the worker can process. */
export function isTrackedEvent(event: string | null | undefined): event is TrackedEvent {
  return typeof event === 'string' && (TRACKED_EVENTS as readonly string[]).includes(event);
}

/**
 * Validate a delivery ID.
 *
 * The route used to forward `req.headers.get('x-github-delivery')` verbatim,
 * `null` included. That matters because the worker guards its idempotency check
 * on the value being truthy:
 *
 *     if (deliveryId) {
 *       const existing = await prisma.webhookEvent.findUnique({ where: { deliveryId } });
 *       ...
 *     }
 *
 * so a delivery arriving without the header skipped the duplicate check
 * entirely. Combined with `attempts: 3` on the queue, a job that failed late —
 * after the scan but before the `webhookEvent.create` that records completion —
 * was fully re-processed on every retry: duplicate scan results, duplicate audit
 * rows, duplicate PR comments, and three times the Groq spend.
 *
 * Every genuine GitHub delivery carries this header, so requiring it costs
 * nothing and closes the hole.
 */
export function normalizeDeliveryId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;

  // GitHub sends a UUID. Constrained rather than free text because this value
  // becomes a BullMQ job ID and a unique database key.
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;

  return trimmed;
}

/**
 * Deterministic BullMQ job ID for a delivery.
 *
 * `addWebhookJob` did not set one, so the queue had no dedupe of its own and the
 * worker's database check was the only thing standing between a replayed
 * delivery and a full re-scan. A stable job ID makes BullMQ collapse duplicates
 * before a worker ever picks one up — cheaper, and it holds even when the
 * database check is skipped.
 */
export function webhookJobId(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

export interface WebhookAdmission {
  /** HTTP status to return when `ok` is false. */
  status: number;
  /** Message safe to return to the caller. */
  message: string;
}

/**
 * Full admission decision for an already-read body.
 *
 * The route composes the individual checks in the order below rather than
 * calling this, but it is exported so the ordering itself is testable:
 *
 *   size → delivery id → signature → parse → dispatch
 *
 * Order matters. The old route filtered on `x-github-event` *before* verifying
 * the signature, so an unauthenticated caller sending `x-github-event: push` got
 * a `200 {"message":"Event not tracked"}`. That is an oracle distinguishing
 * "endpoint exists" from "signature rejected", it makes the endpoint a free
 * unauthenticated 200 responder, and it means `ping` — GitHub's very first
 * delivery when a webhook is registered — was answered without the secret ever
 * being exercised. The webhook then shows as healthy in the GitHub UI while
 * being completely misconfigured, which is the worst possible failure mode for
 * a security product.
 */
export function admitWebhook(options: {
  payloadText: string;
  secret: string | undefined;
  signatureHeader: string | null | undefined;
  deliveryHeader: string | null | undefined;
  contentLength?: string | number | null;
  maxBytes?: number;
}): { ok: true; deliveryId: string; payload: Record<string, unknown> } | ({ ok: false } & WebhookAdmission) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_WEBHOOK_BYTES;

  if (
    isPayloadTooLarge(options.contentLength, maxBytes) ||
    isPayloadTooLarge(payloadByteLength(options.payloadText), maxBytes)
  ) {
    return { ok: false, status: 413, message: 'Webhook payload exceeds the configured size limit' };
  }

  if (!options.secret) {
    // A deployment fault, not a caller fault. `isOperational: false` at the call
    // site keeps the detail out of the response.
    return { ok: false, status: 500, message: 'GITHUB_WEBHOOK_SECRET is not set' };
  }

  const deliveryId = normalizeDeliveryId(options.deliveryHeader);
  if (!deliveryId) {
    return { ok: false, status: 400, message: 'Missing or invalid x-github-delivery header' };
  }

  const signatureHex = parseGithubSignature(options.signatureHeader);
  if (!signatureHex) {
    return { ok: false, status: 401, message: 'Missing or invalid x-hub-signature-256 header' };
  }

  if (!verifySignature(options.payloadText, options.secret, signatureHex)) {
    return { ok: false, status: 401, message: 'Invalid GitHub webhook signature' };
  }

  const parsed = parseWebhookPayload(options.payloadText);
  if (!parsed.ok) {
    return { ok: false, status: 400, message: parsed.reason };
  }

  return { ok: true, deliveryId, payload: parsed.payload };
}
