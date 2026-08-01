/**
 * Resolve a single client IP for rate limiting from proxy headers.
 *
 * Prefer `x-real-ip` (a single platform-set value on Vercel/Cloudflare/Nginx),
 * then fall back to the left-most entry of `x-forwarded-for` (the originating
 * client). We deliberately do NOT use the raw `x-forwarded-for` string as the
 * identity: it is client-supplied and comma-separated, so a caller could append
 * or vary entries on every request to land in a fresh rate-limit bucket and
 * bypass the limit entirely.
 */
export function getClientIp(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return '127.0.0.1';
}
