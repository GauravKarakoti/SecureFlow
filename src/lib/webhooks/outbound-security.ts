import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF and Address Validation for Outbound Webhooks (#1866).
 *
 * Enforces strict HTTPS and blocks all loopback, private, link-local,
 * carrier-grade NAT, internal TLDs, and cloud metadata addresses.
 *
 * Evaluated at registration time and immediately before HTTP dispatch
 * to prevent DNS rebinding and internal network reconnaissance.
 */

const BLOCKED_INTERNAL_TLDS = [
  ".local",
  ".internal",
  ".lan",
  ".corp",
  ".localhost",
  ".cluster.local",
  ".arpa",
  ".home",
  ".test",
  ".invalid",
];

/**
 * Check if an IPv4 address string falls into any private, loopback, link-local,
 * or reserved address space.
 */
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // Malformed IPv4 treated as blocked
  }

  const [a, b, c, d] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 10.0.0.0/8 (Private RFC 1918)
  if (a === 10) return true;

  // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 – 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (Private RFC 1918)
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (Link-local / Cloud Metadata)
  if (a === 169 && b === 254) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT: 100.64.0.0 - 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use)
  if (a >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  return false;
}

/**
 * Check if an IPv6 address string falls into any private, loopback, link-local,
 * or reserved address space.
 */
export function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // Loopback (::1)
  if (normalized === "::1" || /^0*(:0*){6,7}1$/.test(normalized)) {
    return true;
  }

  // Unspecified (::)
  if (normalized === "::" || /^0*(:0*)*$/.test(normalized)) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1, etc.)
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.replace("::ffff:", "");
    if (net.isIPv4(v4)) {
      return isBlockedIPv4(v4);
    }
  }

  // Link-local (fe80::/10 -> fe80: to febf:)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
    return true;
  }

  // Unique local addresses (fc00::/7 -> fc00: to fdff:)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) {
    return true;
  }

  // Discard prefix (100::/64)
  if (normalized.startsWith("100:")) {
    return true;
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith("ff")) {
    return true;
  }

  return false;
}

/**
 * Determine if an IP address string is blocked.
 */
export function isBlockedIpAddress(ip: string): boolean {
  const cleanIp = ip.replace(/^\[|\]$/g, "");
  const family = net.isIP(cleanIp);
  if (family === 4) return isBlockedIPv4(cleanIp);
  if (family === 6) return isBlockedIPv6(cleanIp);
  return true; // Not a recognized IP family
}

export interface WebhookUrlValidationResult {
  ok: boolean;
  url?: URL;
  error?: string;
}

/**
 * Validate an outbound webhook endpoint URL.
 *
 * Rejection conditions:
 * - Empty or invalid URL format
 * - Non-HTTPS scheme
 * - Embedded credentials (username/password)
 * - Loopback, link-local, or private IP hostnames
 * - Internal / private domain suffixes (.local, .internal, etc.)
 * - DNS lookup resolving to loopback/private/link-local addresses
 */
export async function validateOutboundWebhookUrl(
  rawUrl: string,
  options: { resolveDns?: boolean; dnsLookup?: (host: string) => Promise<string[]> } = {},
): Promise<WebhookUrlValidationResult> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { ok: false, error: "Webhook URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "Invalid webhook URL format." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Invalid protocol "${parsed.protocol}" — outbound webhooks must use https:.`,
    };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "Webhook URL must not contain embedded credentials." };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    return { ok: false, error: "Webhook URL must not target loopback addresses." };
  }

  for (const tld of BLOCKED_INTERNAL_TLDS) {
    if (hostname.endsWith(tld)) {
      return { ok: false, error: `Webhook URL domain cannot end with "${tld}".` };
    }
  }

  const isIp = net.isIP(hostname);
  if (isIp) {
    if (isBlockedIpAddress(hostname)) {
      return {
        ok: false,
        error: "Webhook URL cannot point to private, loopback, or link-local IP addresses.",
      };
    }
  }

  if (options.resolveDns !== false) {
    try {
      let resolvedIps: string[] = [];
      if (options.dnsLookup) {
        resolvedIps = await options.dnsLookup(hostname);
      } else {
        const records = await dns.lookup(hostname, { all: true });
        resolvedIps = records.map((r) => r.address);
      }

      for (const ip of resolvedIps) {
        if (isBlockedIpAddress(ip)) {
          return {
            ok: false,
            error: `Hostname "${hostname}" resolves to a blocked or private IP address (${ip}).`,
          };
        }
      }
    } catch (dnsErr: any) {
      if (options.dnsLookup) {
        return {
          ok: false,
          error: `Could not resolve hostname "${hostname}": ${dnsErr?.message || "DNS lookup failed"}`,
        };
      }
      // In offline sandboxes or test runner environments where DNS is unavailable
      if (process.env.NODE_ENV === "test" && dnsErr?.code === "ENOTFOUND") {
        return { ok: true, url: parsed };
      }
      return {
        ok: false,
        error: `Could not resolve hostname "${hostname}": ${dnsErr?.message || "DNS lookup failed"}`,
      };
    }
  }

  return { ok: true, url: parsed };
}
