/**
 * Resolve a single, trustworthy client IP for rate limiting.
 *
 * The previous implementation read `x-real-ip`, then fell back to the left-most
 * entry of `x-forwarded-for`. Both are attacker-controlled. A caller could send
 * a different `x-real-ip` on every request, land in a fresh Redis bucket each
 * time, and never hit a limit — which made every rate limit in the application
 * decorative:
 *
 *     for i in $(seq 1 500); do
 *       curl -H "x-real-ip: 10.0.0.$RANDOM" https://host/api/og/heist
 *     done
 *
 * The fix is to stop treating the headers as data and start treating them as a
 * chain with a known trusted suffix. `X-Forwarded-For` is append-only: each
 * proxy appends the address it received the connection *from*. So with `n`
 * trusted proxies in front of the app, the entry at `chain.length - n` is the
 * address the outermost trusted proxy actually observed — the last value the
 * client could not forge. Everything to its left is whatever the client typed.
 *
 *     client sends: "1.2.3.4"                  (a lie)
 *     CDN appends:  "1.2.3.4, 203.0.113.9"
 *     n = 1  ->  chain[2 - 1] = "203.0.113.9"  <- the real client
 *
 * Configuration:
 *
 *   TRUSTED_PROXY_HOP_COUNT  number of trusted proxies in front of the app.
 *                            Default 1 (Vercel, Render, Cloudflare, a single
 *                            nginx). Set to 0 when the app is exposed directly,
 *                            which makes the forwarding headers untrusted
 *                            entirely.
 *   TRUSTED_PROXY_IPS        optional comma-separated allowlist of proxy
 *                            addresses / IPv4 CIDRs. When set, the chain is
 *                            walked from the right past known proxies instead of
 *                            counting a fixed number of hops, which is more
 *                            robust when the hop count varies.
 */

/**
 * Returned when no trustworthy address can be derived.
 *
 * Deliberately not a plausible-looking IP. The old code returned `127.0.0.1`,
 * so in a deployment where the proxy headers were missing every caller silently
 * collapsed into one shared bucket and a single noisy client rate-limited
 * everybody else. A distinct sentinel still shares a bucket — unavoidable
 * without a real address — but it is visible in metrics and in the Redis
 * keyspace as the misconfiguration it represents.
 */
export const UNKNOWN_CLIENT_IP = 'unknown';

/**
 * Longest header value worth parsing.
 *
 * The resolved value becomes part of a Redis key, so an unbounded header would
 * mean an unbounded key. A legitimate chain of a dozen IPv6 addresses fits in
 * far less than this.
 */
const MAX_FORWARDED_HEADER_LENGTH = 1024;

/** Longest single address worth parsing (an IPv6 literal with a zone and port). */
const MAX_ADDRESS_LENGTH = 64;

/** Cap on chain entries, so a header full of commas cannot cost anything. */
const MAX_CHAIN_ENTRIES = 32;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strict dotted-quad check — rejects leading zeros and out-of-range octets. */
function isIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;

  for (let i = 1; i <= 4; i++) {
    const octet = match[i];
    // "01.2.3.4" and "1.2.3.4" are the same host to some parsers and different
    // strings to Redis; rejecting leading zeros keeps one client to one bucket.
    if (octet.length > 1 && octet.startsWith('0')) return false;
    if (Number(octet) > 255) return false;
  }

  return true;
}

/**
 * Structural IPv6 check.
 *
 * Accepts the compressed (`::`) forms and the IPv4-mapped tail, and rejects a
 * value carrying more than one `::`. This is a validity gate for a cache key,
 * not a parser — it needs to reject junk, not to canonicalise every RFC 4291
 * spelling.
 */
function isIpv6(value: string): boolean {
  if (!value.includes(':')) return false;
  if ((value.match(/::/g) ?? []).length > 1) return false;

  const groups = value.split(':');
  if (groups.length > 9) return false;

  const compressed = value.includes('::');
  let seen = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group === '') continue; // part of a `::` run, or a leading/trailing colon

    // An IPv4 tail (::ffff:192.0.2.1) is only legal in the final position.
    if (group.includes('.')) {
      if (i !== groups.length - 1) return false;
      if (!isIpv4(group)) return false;
      seen += 2;
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    seen += 1;
  }

  return compressed ? seen <= 8 : seen === 8;
}

/**
 * Reduce an address to one canonical spelling.
 *
 * Without this, `1.2.3.4`, `1.2.3.4:8080`, `::ffff:1.2.3.4` and `::FFFF:1.2.3.4`
 * are four different Redis keys for one client — four times the quota.
 *
 * Returns `null` when the value is not a valid address at all, which is what
 * keeps header junk out of the key.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value || value.length > MAX_ADDRESS_LENGTH) return null;

  // Bracketed IPv6, with or without a port: "[::1]" / "[::1]:443"
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    value = value.slice(1, close);
  } else if (value.includes(':')) {
    // Exactly one colon means "host:port"; more than one means a bare IPv6
    // literal, which must not be truncated.
    const firstColon = value.indexOf(':');
    if (firstColon === value.lastIndexOf(':')) {
      value = value.slice(0, firstColon);
    }
  }

  // Drop an IPv6 zone index: it names a local interface rather than the client,
  // and it is free text that would otherwise reach the key.
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  if (!value) return null;

  if (isIpv4(value)) return value;

  if (isIpv6(value)) {
    const lowered = value.toLowerCase();
    // Collapse the IPv4-mapped form so a dual-stack proxy cannot hand one client
    // two identities.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lowered);
    if (mapped && isIpv4(mapped[1])) return mapped[1];
    return lowered;
  }

  return null;
}

/** Parsed trusted-proxy allowlist entry. */
export type TrustedEntry =
  | { kind: 'exact'; value: string }
  | { kind: 'cidr4'; base: number; mask: number };

function ipv4ToInt(value: string): number | null {
  if (!isIpv4(value)) return null;
  return value.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

/**
 * Parse `TRUSTED_PROXY_IPS`.
 *
 * Accepts bare addresses and IPv4 CIDR blocks (`10.0.0.0/8`). IPv6 is matched
 * exactly rather than by prefix: proxy fleets are normally enumerated or
 * IPv4-addressed, and a half-correct IPv6 prefix matcher is worse than an honest
 * exact match. Unparseable entries are dropped rather than silently widening
 * trust.
 */
export function parseTrustedProxies(raw: string | null | undefined): TrustedEntry[] {
  if (!raw) return [];

  const entries: TrustedEntry[] = [];

  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;

    const slash = token.indexOf('/');
    if (slash === -1) {
      const normalized = normalizeIp(token);
      if (normalized) entries.push({ kind: 'exact', value: normalized });
      continue;
    }

    const base = ipv4ToInt(token.slice(0, slash));
    const bits = Number(token.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;

    // `x << 32` is a no-op in JavaScript, so /0 is special-cased.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    entries.push({ kind: 'cidr4', base: (base & mask) >>> 0, mask });
  }

  return entries;
}

function isTrustedProxy(ip: string, trusted: TrustedEntry[]): boolean {
  if (trusted.length === 0) return false;

  const asInt = ipv4ToInt(ip);

  for (const entry of trusted) {
    if (entry.kind === 'exact') {
      if (entry.value === ip) return true;
      continue;
    }
    if (asInt !== null && ((asInt & entry.mask) >>> 0) === entry.base) return true;
  }

  return false;
}

/**
 * Split `x-forwarded-for` into normalized addresses, left to right.
 *
 * Entries that are not valid addresses are dropped. Dropping rather than
 * preserving them stops a caller padding the chain with junk to shift the
 * hop-count index — every remaining position is a real address.
 */
export function parseForwardedChain(header: string | null | undefined): string[] {
  if (!header || header.length > MAX_FORWARDED_HEADER_LENGTH) return [];

  const chain: string[] = [];

  for (const part of header.split(',')) {
    if (chain.length >= MAX_CHAIN_ENTRIES) break;
    const normalized = normalizeIp(part);
    if (normalized) chain.push(normalized);
  }

  return chain;
}

/**
 * Read and validate `TRUSTED_PROXY_HOP_COUNT`.
 *
 * A malformed value falls back to the safe default of 1 rather than to 0 (which
 * would discard the headers and collapse everyone into one bucket) or to a large
 * number (which would trust the whole chain).
 */
export function resolveHopCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_CHAIN_ENTRIES) return 1;

  return parsed;
}

export interface ClientIpOptions {
  /** Trusted proxies in front of the app. Defaults to `TRUSTED_PROXY_HOP_COUNT`, or 1. */
  trustedHopCount?: number;
  /** Trusted proxy allowlist. Defaults to `TRUSTED_PROXY_IPS`. */
  trustedProxies?: TrustedEntry[];
}

/**
 * Resolve the client IP to use as a rate-limit identity.
 *
 * Resolution order:
 *
 *  1. With a trusted-proxy allowlist configured, walk `x-forwarded-for` from the
 *     right, skipping known proxies. The first entry that is not a known proxy
 *     is the client.
 *  2. Otherwise take `chain[chain.length - trustedHopCount]` — the address the
 *     outermost trusted proxy observed.
 *  3. If there is no usable chain but at least one trusted hop is configured,
 *     fall back to `x-real-ip`, which that proxy is expected to have set.
 *  4. Otherwise `UNKNOWN_CLIENT_IP`.
 *
 * With `trustedHopCount === 0` and no allowlist, the app is treated as directly
 * exposed and the forwarding headers are ignored entirely — nothing in front of
 * it is authoritative.
 */
export function getClientIp(headers: Headers, options: ClientIpOptions = {}): string {
  const trustedHopCount =
    options.trustedHopCount ?? resolveHopCount(process.env.TRUSTED_PROXY_HOP_COUNT);
  const trustedProxies =
    options.trustedProxies ?? parseTrustedProxies(process.env.TRUSTED_PROXY_IPS);

  if (trustedHopCount === 0 && trustedProxies.length === 0) {
    return UNKNOWN_CLIENT_IP;
  }

  const chain = parseForwardedChain(headers.get('x-forwarded-for'));

  if (chain.length > 0) {
    if (trustedProxies.length > 0) {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(chain[i], trustedProxies)) return chain[i];
      }
      // Every hop is a known proxy — the left-most is the closest thing to a
      // client the chain contains.
      return chain[0];
    }

    const index = chain.length - trustedHopCount;
    if (index >= 0 && index < chain.length) return chain[index];

    // The chain is shorter than the configured hop count, so the request did not
    // traverse the proxies this deployment expects and nothing in it is
    // trustworthy.
    return UNKNOWN_CLIENT_IP;
  }

  // No chain. A trusted proxy that sets `x-real-ip` (nginx, Vercel, Cloudflare)
  // but not `x-forwarded-for` is the remaining legitimate case. Only consulted
  // when a trusted hop is configured, so a directly exposed deployment never
  // honours a client-supplied `x-real-ip`.
  if (trustedHopCount > 0 || trustedProxies.length > 0) {
    const realIp = normalizeIp(headers.get('x-real-ip'));
    if (realIp) return realIp;
  }

  return UNKNOWN_CLIENT_IP;
}
