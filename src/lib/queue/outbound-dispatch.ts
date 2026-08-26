/**
 * Outbound webhook dispatch (#642).
 *
 * `outboundWorker.ts` used to be eight lines of `fetch(url, { method: 'POST' })`
 * where `url` came out of the job payload. That is the most dangerous shape a
 * background worker can have: it runs inside our network, with Redis and
 * Postgres reachable, and it will connect to whatever address a job names.
 *
 * Everything here exists to bound one of the four things that were unbounded:
 *
 *  1. **Where we connect.** {@link assertDispatchableUrl} rejects non-HTTP
 *     schemes, rejects plaintext HTTP outside development, and rejects any
 *     destination that resolves into a private, loopback, link-local or
 *     otherwise internal range — the cloud metadata service at
 *     `169.254.169.254` being the one that actually gets exploited.
 *  2. **How long we wait.** Every request carries a deadline. BullMQ has no
 *     job timeout of its own, so without this a receiver that accepts the
 *     connection and never answers holds a worker slot until the process
 *     restarts, while the job sits in `active` where no alert will find it.
 *  3. **How much we read.** The old code never touched `response.body`, which
 *     under undici keeps the socket alive until GC. We now drain a bounded
 *     prefix and release the rest.
 *  4. **How often we retry.** A 404 is not going to become a 200 on the third
 *     attempt. {@link classifyResponseStatus} separates the outcomes worth
 *     retrying from the ones that only cost us backoff.
 *
 * DNS is resolved before the socket is opened and the *resolved addresses* are
 * checked, not just the hostname. A name that looks external and answers with
 * `127.0.0.1` is the standard way around a hostname allowlist.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';

/** Default per-request deadline. Generous for a webhook, far short of forever. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Hard ceiling on a configured timeout, so an env typo cannot restore the old behaviour. */
export const MAX_TIMEOUT_MS = 60_000;

/** Bytes of the response we are willing to read before hanging up. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/** Version tag on the signature header, so the scheme can change without breaking receivers. */
export const SIGNATURE_VERSION = 'v1';

/** Header names, exported so tests and receivers agree on the spelling. */
export const SIGNATURE_HEADER = 'X-SecureFlow-Signature';
export const TIMESTAMP_HEADER = 'X-SecureFlow-Timestamp';
export const DELIVERY_HEADER = 'X-SecureFlow-Delivery';

/**
 * Hostnames that name the machine or the platform rather than a peer.
 *
 * `metadata.google.internal` is listed explicitly because it resolves to a
 * link-local address only from inside GCP — a check that ran on a developer
 * laptop would see NXDOMAIN and wave it through.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/**
 * Raised when a destination is refused before any connection is attempted.
 *
 * Always permanent: a job pointed at `127.0.0.1` will still be pointed at
 * `127.0.0.1` on the next attempt.
 */
export class OutboundDestinationError extends Error {
  public readonly retryable = false as const;

  constructor(message: string) {
    super(message);
    this.name = 'OutboundDestinationError';
    Object.setPrototypeOf(this, OutboundDestinationError.prototype);
  }
}

/** Raised when a dispatch was attempted and did not succeed. */
export class OutboundDeliveryError extends Error {
  public readonly retryable: boolean;
  public readonly status?: number;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'OutboundDeliveryError';
    this.retryable = retryable;
    this.status = status;
    Object.setPrototypeOf(this, OutboundDeliveryError.prototype);
  }
}

export interface DispatchConfig {
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
  /** Bytes of response body read before the connection is released. */
  maxResponseBytes: number;
  /** When non-empty, only these hostnames may be dispatched to. */
  allowedHosts: string[];
  /** Permit plaintext `http://`. Development only. */
  allowInsecureHttp: boolean;
  /** Permit private / loopback destinations. Development and self-hosted test rigs only. */
  allowPrivateNetworks: boolean;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseBoolean(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'true';
}

/**
 * Read the dispatch policy from the environment.
 *
 * The permissive switches (`ALLOW_INSECURE_HTTP`, `ALLOW_PRIVATE_NETWORKS`) are
 * ignored entirely when `NODE_ENV === 'production'`. An operator cannot turn off
 * the SSRF guard in production by setting an environment variable, which is
 * exactly how these guards usually end up disabled.
 */
export function resolveDispatchConfig(env: NodeJS.ProcessEnv = process.env): DispatchConfig {
  const isProduction = env.NODE_ENV === 'production';

  const allowedHosts = (env.OUTBOUND_WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);

  return {
    timeoutMs: parsePositiveInt(
      env.OUTBOUND_WEBHOOK_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    maxResponseBytes: parsePositiveInt(
      env.OUTBOUND_WEBHOOK_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      1024 * 1024
    ),
    allowedHosts,
    allowInsecureHttp: !isProduction && parseBoolean(env.OUTBOUND_WEBHOOK_ALLOW_INSECURE_HTTP),
    allowPrivateNetworks:
      !isProduction && parseBoolean(env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_NETWORKS),
  };
}

/** Parse a dotted-quad into its four octets, or null if it is not one. */
function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    // Reject `01`, `+1`, `0x7f` and friends: they parse differently in different
    // resolvers, which is how an "obviously public" literal becomes loopback.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }

  return octets;
}

/**
 * True when an IPv4 literal names something that is not a public peer.
 *
 * Covers the ranges that matter for SSRF rather than every reservation in the
 * registry: loopback, the two RFC1918 blocks plus 172.16/12, link-local (which
 * is where every cloud metadata service lives), carrier-grade NAT, the
 * benchmarking and documentation blocks, multicast, and the reserved 240/4.
 */
export function isPrivateIPv4(value: string): boolean {
  const octets = parseIPv4(value);
  if (!octets) return false;

  const [a, b] = octets;

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 documentation
  if (a === 203 && b === 0) return true; // 203.0.113/24 documentation
  if (a >= 224) return true; // multicast (224/4) and reserved (240/4)

  return false;
}

/** Render the last two hextets of an IPv4-mapped address as a dotted quad. */
function hextetsToIPv4(high: string, low: string): string {
  const a = Number.parseInt(high, 16);
  const b = Number.parseInt(low, 16);
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
}

/**
 * True when an IPv6 literal names something that is not a public peer.
 *
 * IPv4-mapped forms are unwrapped and re-checked as IPv4 — skipping that step
 * is the most common way an IPv6-aware blocklist gets bypassed. Both spellings
 * have to be handled: a caller may write `::ffff:127.0.0.1`, but the WHATWG URL
 * parser canonicalises that to the hextet form `::ffff:7f00:1` before we ever
 * read `url.hostname`, so matching only the dotted form catches nothing.
 */
export function isPrivateIPv6(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];

  if (normalized === '::' || normalized === '::1') return true;

  // ::ffff:127.0.0.1 and the deprecated IPv4-compatible ::127.0.0.1
  const dotted = normalized.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isPrivateIPv4(dotted[1]);

  // ::ffff:7f00:1 — the form Node's URL parser actually produces.
  const hextets = normalized.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hextets) return isPrivateIPv4(hextetsToIPv4(hextets[1], hextets[2]));

  // 6to4 / NAT64 wrappers that trail a dotted quad.
  const embedded = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded && isPrivateIPv4(embedded[1])) return true;

  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true; // ff00::/8 multicast

  return false;
}

/** True for any address literal we refuse to connect to. */
export function isPrivateAddress(value: string): boolean {
  if (!value) return true;
  return value.includes(':') ? isPrivateIPv6(value) : isPrivateIPv4(value);
}

/** True when a hostname names the local machine or a platform metadata service. */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  // `.localhost` and `.internal` are reserved for exactly this purpose.
  return normalized.endsWith('.localhost') || normalized.endsWith('.internal');
}

/**
 * Human-readable destination with no secret material.
 *
 * Most webhook providers put a token in the path or the query string, so the
 * full URL must never reach a log. Scheme, host and port are enough to debug a
 * delivery failure.
 */
export function describeDestination(url: URL): string {
  return url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`;
}

/** Resolves a hostname to address literals. Injected so tests never touch DNS. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: AddressResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => record.address);
};

export interface ValidateDestinationOptions {
  config?: DispatchConfig;
  resolve?: AddressResolver;
}

/**
 * Validate a destination and return the parsed URL, or throw.
 *
 * The order matters. Syntax and scheme are cheap and are checked first; the
 * allowlist is checked before DNS so an allowlisted deployment never pays for a
 * lookup it is going to ignore; the resolved addresses are checked last because
 * that is the only step that can fail for reasons unrelated to the URL.
 */
export async function assertDispatchableUrl(
  rawUrl: string,
  options: ValidateDestinationOptions = {}
): Promise<URL> {
  const config = options.config ?? resolveDispatchConfig();
  const resolve = options.resolve ?? defaultResolver;

  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new OutboundDestinationError('Webhook URL is missing.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new OutboundDestinationError('Webhook URL is not a valid absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundDestinationError(
      `Unsupported webhook scheme "${url.protocol}" — only http and https are dispatchable.`
    );
  }

  if (url.protocol === 'http:' && !config.allowInsecureHttp) {
    throw new OutboundDestinationError(
      'Refusing to dispatch a webhook over plaintext http. Use https.'
    );
  }

  // Credentials in the authority are never meaningful for a webhook and are a
  // reliable sign the URL was assembled from somewhere it should not have been.
  if (url.username || url.password) {
    throw new OutboundDestinationError('Webhook URL must not embed credentials.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (config.allowedHosts.length > 0 && !config.allowedHosts.includes(hostname)) {
    throw new OutboundDestinationError(
      `Host "${hostname}" is not in OUTBOUND_WEBHOOK_ALLOWED_HOSTS.`
    );
  }

  if (config.allowPrivateNetworks) {
    return url;
  }

  if (isBlockedHostname(hostname)) {
    throw new OutboundDestinationError(`Refusing to dispatch to internal host "${hostname}".`);
  }

  // A literal address needs no lookup, and passing one to the resolver would
  // just hand it straight back.
  if (isPrivateAddress(hostname)) {
    throw new OutboundDestinationError(
      `Refusing to dispatch to private or reserved address "${hostname}".`
    );
  }

  const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  if (isLiteral) {
    return url;
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    // A name we cannot resolve is not a name we should connect to. Retryable,
    // because DNS failures are usually transient.
    throw new OutboundDeliveryError(`Could not resolve webhook host "${hostname}".`, true);
  }

  if (addresses.length === 0) {
    throw new OutboundDeliveryError(`Webhook host "${hostname}" resolved to no addresses.`, true);
  }

  const internal = addresses.find((address) => isPrivateAddress(address));
  if (internal) {
    throw new OutboundDestinationError(
      `Host "${hostname}" resolves to the internal address ${internal}.`
    );
  }

  return url;
}

/**
 * Build the signature for a payload.
 *
 * Signed over `${timestamp}.${body}` rather than the body alone so a receiver
 * can reject a replay by rejecting an old timestamp — the old bare-body HMAC
 * was valid forever. The `t=`/`v1=` shape lets the algorithm be rotated without
 * a receiver having to guess which one it is looking at.
 */
export function buildSignatureHeader(secret: string, body: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},${SIGNATURE_VERSION}=${digest}`;
}

/**
 * Verify a signature header. Provided so receivers in this repo (and the tests)
 * do not each hand-roll the comparison and get the timing wrong.
 */
export function verifySignatureHeader(
  header: string,
  secret: string,
  body: string,
  toleranceSeconds = 300,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  const parts = new Map(
    header
      .split(',')
      .map((segment) => segment.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get(SIGNATURE_VERSION);
  if (!Number.isFinite(timestamp) || !provided) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type StatusClass = 'success' | 'retryable' | 'permanent';

/**
 * Decide what an HTTP status means for a retry.
 *
 * 3xx is deliberately permanent: we dispatch with `redirect: 'manual'`, so a
 * redirect is a receiver telling us to connect somewhere we have not validated.
 * Following it would undo the whole destination check, and retrying it would
 * just produce the same redirect.
 */
export function classifyResponseStatus(status: number): StatusClass {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 425 || status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  return 'permanent';
}

/**
 * Read at most `limit` bytes of a response and release the connection.
 *
 * Returning the prefix is worth the small cost: a receiver's error body is
 * usually the only explanation of why a delivery failed, and without it the DLQ
 * entry says nothing more than "400".
 */
export async function drainBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = limit - total;
      chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.length, remaining);
    }
  } catch {
    // A body that fails mid-read tells us nothing useful; the status already did.
  } finally {
    // Releases the socket whether we read all of it or gave up at the cap.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(merged);
}

export interface OutboundWebhookRequest {
  url: string;
  payload: Record<string, unknown> | string;
  secret?: string;
  /** Correlates the delivery across our logs and the receiver's. */
  deliveryId?: string;
}

export interface DispatchOptions {
  config?: DispatchConfig;
  resolve?: AddressResolver;
  /** Injected so tests do not need a live socket. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected so a signature can be asserted deterministically. */
  deliveryId?: string;
}

export interface DispatchResult {
  status: number;
  destination: string;
  deliveryId: string;
  durationMs: number;
  /** Bounded prefix of the receiver's response, for diagnostics. */
  bodyPreview: string;
}

/**
 * Dispatch one outbound webhook.
 *
 * Throws {@link OutboundDestinationError} for a destination we refuse outright
 * and {@link OutboundDeliveryError} for an attempt that failed, with
 * `retryable` set so the worker can decide between a retry and the DLQ.
 */
export async function dispatchOutboundWebhook(
  request: OutboundWebhookRequest,
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const config = options.config ?? resolveDispatchConfig();
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const url = await assertDispatchableUrl(request.url, { config, resolve: options.resolve });
  const destination = describeDestination(url);
  const deliveryId = options.deliveryId ?? request.deliveryId ?? randomUUID();

  const body =
    typeof request.payload === 'string' ? request.payload : JSON.stringify(request.payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'SecureFlow-Webhooks/1.0',
    [DELIVERY_HEADER]: deliveryId,
  };

  if (request.secret) {
    const timestamp = Math.floor(now() / 1000);
    headers[TIMESTAMP_HEADER] = String(timestamp);
    headers[SIGNATURE_HEADER] = buildSignatureHeader(request.secret, body, timestamp);
  }

  const startedAt = now();
  let response: Response;

  try {
    response = await doFetch(url.toString(), {
      method: 'POST',
      headers,
      body,
      // A 3xx is a destination we have not validated. Never follow it.
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

    throw new OutboundDeliveryError(
      isTimeout
        ? `Webhook to ${destination} timed out after ${config.timeoutMs}ms.`
        : `Webhook to ${destination} failed: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }

  const bodyPreview = await drainBody(response, config.maxResponseBytes);
  const durationMs = now() - startedAt;
  const outcome = classifyResponseStatus(response.status);

  if (outcome === 'success') {
    return { status: response.status, destination, deliveryId, durationMs, bodyPreview };
  }

  const redirected = response.status >= 300 && response.status < 400;
  throw new OutboundDeliveryError(
    redirected
      ? `Webhook to ${destination} returned a ${response.status} redirect, which is not followed.`
      : `Webhook to ${destination} failed with HTTP ${response.status}.`,
    outcome === 'retryable',
    response.status
  );
}
