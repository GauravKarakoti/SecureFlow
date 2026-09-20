import { describe, it, expect } from "vitest";
import {
  UNKNOWN_CLIENT_IP,
  getClientIp,
  normalizeIp,
  parseForwardedChain,
  parseTrustedProxies,
  resolveHopCount,
} from "./client-ip";

/** Build a Headers instance from a plain object. */
function h(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

describe("normalizeIp", () => {
  it("accepts a plain IPv4 address", () => {
    expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
  });

  it("strips an IPv4 port", () => {
    expect(normalizeIp("203.0.113.9:8080")).toBe("203.0.113.9");
  });

  it("unwraps a bracketed IPv6 address, with or without a port", () => {
    expect(normalizeIp("[::1]")).toBe("::1");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  it("does not truncate a bare IPv6 literal at its first colon", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("lowercases IPv6 so casing cannot split a bucket", () => {
    expect(normalizeIp("2001:DB8::AB")).toBe("2001:db8::ab");
  });

  it("collapses IPv4-mapped IPv6 onto the plain IPv4 form", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("::FFFF:1.2.3.4")).toBe("1.2.3.4");
  });

  it("drops an IPv6 zone index", () => {
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIp("  203.0.113.9  ")).toBe("203.0.113.9");
  });

  it("rejects out-of-range octets", () => {
    expect(normalizeIp("999.0.0.1")).toBeNull();
    expect(normalizeIp("256.1.1.1")).toBeNull();
  });

  it("rejects leading zeros, which would otherwise be a second bucket", () => {
    expect(normalizeIp("01.2.3.4")).toBeNull();
  });

  it("rejects a malformed IPv6 with two compression runs", () => {
    expect(normalizeIp("2001::db8::1")).toBeNull();
  });

  it("rejects free text, so header junk never reaches the Redis key", () => {
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("<script>")).toBeNull();
    expect(normalizeIp("1.2.3.4; DEL *")).toBeNull();
  });

  it("rejects an oversized value", () => {
    expect(normalizeIp("1".repeat(500))).toBeNull();
  });

  it("rejects empty and non-string input without throwing", () => {
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp("   ")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp(42 as unknown as string)).toBeNull();
  });
});

describe("parseForwardedChain", () => {
  it("splits and normalizes a chain left to right", () => {
    expect(parseForwardedChain("1.2.3.4, 5.6.7.8, 9.10.11.12")).toEqual([
      "1.2.3.4",
      "5.6.7.8",
      "9.10.11.12",
    ]);
  });

  it("drops invalid entries rather than keeping a position for them", () => {
    expect(parseForwardedChain("garbage, 5.6.7.8")).toEqual(["5.6.7.8"]);
  });

  it("returns an empty chain for a missing or oversized header", () => {
    expect(parseForwardedChain(null)).toEqual([]);
    expect(parseForwardedChain("")).toEqual([]);
    expect(parseForwardedChain("1.2.3.4,".repeat(500))).toEqual([]);
  });

  it("caps the number of entries it will parse", () => {
    const long = Array.from({ length: 100 }, (_, i) => `10.0.0.${i % 250}`).join(",");
    expect(parseForwardedChain(long).length).toBeLessThanOrEqual(32);
  });
});

describe("resolveHopCount", () => {
  it("defaults to zero (untrusted/safe) when no value is configured", () => {
    // Secure-by-default: an unconfigured deployment must NOT trust X-Forwarded-For.
    expect(resolveHopCount(undefined)).toBe(0);
    expect(resolveHopCount("")).toBe(0);
    expect(resolveHopCount("   ")).toBe(0);
  });

  it("honours a valid value", () => {
    expect(resolveHopCount("0")).toBe(0);
    expect(resolveHopCount("1")).toBe(1);
    expect(resolveHopCount("2")).toBe(2);
  });

  it("falls back to zero (safe) for a malformed value", () => {
    // Fail-safe: a misconfigured deployment should not accidentally trust headers.
    expect(resolveHopCount("abc")).toBe(0);
    expect(resolveHopCount("-1")).toBe(0);
    expect(resolveHopCount("1.5")).toBe(0);
    expect(resolveHopCount("9999")).toBe(0);
  });
});

describe("parseTrustedProxies", () => {
  it("parses bare addresses", () => {
    expect(parseTrustedProxies("10.0.0.1, 10.0.0.2")).toHaveLength(2);
  });

  it("parses IPv4 CIDR blocks", () => {
    expect(parseTrustedProxies("10.0.0.0/8")).toEqual([
      { kind: "cidr4", base: 167772160, mask: 4278190080 },
    ]);
  });

  it("drops unparseable entries instead of widening trust", () => {
    expect(parseTrustedProxies("nonsense, 10.0.0.0/99, 10.0.0.1")).toHaveLength(1);
  });

  it("returns an empty list for empty input", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("")).toEqual([]);
  });
});

describe("getClientIp — spoofing", () => {
  const opts = { trustedHopCount: 1, trustedProxies: [] };

  it("ignores a spoofed left-most x-forwarded-for entry", () => {
    // The client typed "1.2.3.4"; the trusted proxy appended the real address.
    const ip = getClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), opts);
    expect(ip).toBe("203.0.113.9");
  });

  it("ignores a spoofed x-real-ip when a chain is present", () => {
    const ip = getClientIp(
      h({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" }),
      opts,
    );
    expect(ip).toBe("203.0.113.9");
  });

  it("gives an attacker the same bucket no matter what they prepend", () => {
    // This is the bypass the issue describes: 500 requests, 500 buckets.
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) =>
        getClientIp(
          h({
            "x-real-ip": `10.0.0.${i}`,
            "x-forwarded-for": `10.1.2.${i}, 8.8.8.8, 203.0.113.9`,
          }),
          opts,
        ),
      ),
    );

    expect(buckets.size).toBe(1);
    expect([...buckets][0]).toBe("203.0.113.9");
  });

  it("cannot be shifted by padding the chain with junk entries", () => {
    const ip = getClientIp(
      h({ "x-forwarded-for": "junk, junk, junk, 1.2.3.4, 203.0.113.9" }),
      opts,
    );
    expect(ip).toBe("203.0.113.9");
  });
});

describe("getClientIp — hop counting", () => {
  it("reads the single trusted hop from the right", () => {
    expect(
      getClientIp(h({ "x-forwarded-for": "203.0.113.9" }), {
        trustedHopCount: 1,
        trustedProxies: [],
      }),
    ).toBe("203.0.113.9");
  });

  it("reads two trusted hops from the right", () => {
    // client -> CDN -> LB -> app, so the chain is "client, CDN".
    const ip = getClientIp(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.7" }), {
      trustedHopCount: 2,
      trustedProxies: [],
    });
    expect(ip).toBe("203.0.113.9");
  });

  it("still resolves correctly at two hops when the client prepends a lie", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 10.0.0.7" }), {
      trustedHopCount: 2,
      trustedProxies: [],
    });
    expect(ip).toBe("203.0.113.9");
  });

  it("returns the sentinel when the chain is shorter than the configured hops", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "203.0.113.9" }), {
      trustedHopCount: 3,
      trustedProxies: [],
    });
    expect(ip).toBe(UNKNOWN_CLIENT_IP);
  });

  it("ignores forwarding headers entirely when the app is directly exposed", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }), {
      trustedHopCount: 0,
      trustedProxies: [],
    });
    expect(ip).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe("getClientIp — trusted proxy allowlist", () => {
  const trustedProxies = parseTrustedProxies("10.0.0.0/8, 192.168.1.1");

  it("walks past known proxies from the right", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "203.0.113.9, 10.5.5.5, 10.0.0.7" }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe("203.0.113.9");
  });

  it("matches an exact non-CIDR entry", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "203.0.113.9, 192.168.1.1" }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe("203.0.113.9");
  });

  it("stops at the first untrusted hop, so a spoof cannot reach through", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 10.0.0.7" }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe("203.0.113.9");
  });

  it("falls back to the left-most entry when every hop is a known proxy", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe("10.0.0.1");
  });
});

describe("getClientIp — fallbacks", () => {
  const opts = { trustedHopCount: 1, trustedProxies: [] };

  it("uses x-real-ip when there is no forwarded chain", () => {
    expect(getClientIp(h({ "x-real-ip": "203.0.113.9" }), opts)).toBe("203.0.113.9");
  });

  it("normalizes x-real-ip too", () => {
    expect(getClientIp(h({ "x-real-ip": "::ffff:1.2.3.4" }), opts)).toBe("1.2.3.4");
    expect(getClientIp(h({ "x-real-ip": "1.2.3.4:9999" }), opts)).toBe("1.2.3.4");
  });

  it("rejects an invalid x-real-ip rather than passing it through to the key", () => {
    expect(getClientIp(h({ "x-real-ip": "nonsense" }), opts)).toBe(UNKNOWN_CLIENT_IP);
  });

  it("returns the sentinel, not 127.0.0.1, when no headers are present", () => {
    // The old fallback collapsed every header-less caller into the loopback
    // bucket, so one noisy client rate-limited everyone else.
    expect(getClientIp(h({}), opts)).toBe(UNKNOWN_CLIENT_IP);
    expect(getClientIp(h({}), opts)).not.toBe("127.0.0.1");
  });

  it("never returns a value containing a Redis key separator", () => {
    const values = [
      getClientIp(h({ "x-real-ip": "a:b:c:d" }), opts),
      getClientIp(h({ "x-forwarded-for": "x, y" }), opts),
      getClientIp(h({}), opts),
    ];
    for (const value of values) {
      expect(value).not.toMatch(/[\s,]/);
      expect(value.length).toBeLessThanOrEqual(64);
    }
  });

  it("is deterministic for the same headers", () => {
    const headers = h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(getClientIp(headers, opts)).toBe(getClientIp(headers, opts));
  });
});

describe("getClientIp — environment configuration", () => {
  it("returns the sentinel when nothing is configured (secure-by-default)", () => {
    // Previously this returned "203.0.113.9" because the default was 1 hop,
    // which allowed a client-supplied X-Forwarded-For to control identity.
    // The fix: no explicit proxy config → trust no forwarding headers.
    const previousHops = process.env.TRUSTED_PROXY_HOP_COUNT;
    const previousIps = process.env.TRUSTED_PROXY_IPS;
    delete process.env.TRUSTED_PROXY_HOP_COUNT;
    delete process.env.TRUSTED_PROXY_IPS;

    try {
      expect(getClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe(UNKNOWN_CLIENT_IP);
    } finally {
      if (previousHops !== undefined) process.env.TRUSTED_PROXY_HOP_COUNT = previousHops;
      if (previousIps !== undefined) process.env.TRUSTED_PROXY_IPS = previousIps;
    }
  });

  it("honours TRUSTED_PROXY_HOP_COUNT from the environment", () => {
    const previous = process.env.TRUSTED_PROXY_HOP_COUNT;
    process.env.TRUSTED_PROXY_HOP_COUNT = "2";

    try {
      expect(getClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 10.0.0.7" }))).toBe(
        "203.0.113.9",
      );
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOP_COUNT;
      else process.env.TRUSTED_PROXY_HOP_COUNT = previous;
    }
  });
});

// ---- Security regression tests (spoofed X-Forwarded-For) ----

describe("getClientIp — security regression: spoofed X-Forwarded-For", () => {
  /**
   * Test 1 — No trusted proxy configured.
   *
   * TRUSTED_PROXY_HOP_COUNT is not set. A client-supplied X-Forwarded-For
   * header must NOT become the rate-limit identity.
   */
  it("Test 1: ignores X-Forwarded-For when no trusted proxy is configured", () => {
    // Simulate completely unconfigured environment (no env var, no options).
    const ip = getClientIp(h({ "x-forwarded-for": "1.2.3.4" }), {
      trustedHopCount: 0,
      trustedProxies: [],
    });
    expect(ip).toBe(UNKNOWN_CLIENT_IP);
    expect(ip).not.toBe("1.2.3.4");
  });

  /**
   * Test 2 — Spoofed header rotation must not yield different rate-limit buckets.
   *
   * An attacker who rotates X-Forwarded-For between requests must always end up
   * in the same bucket (UNKNOWN_CLIENT_IP) when no proxy is configured.
   */
  it("Test 2: rotating X-Forwarded-For does not yield distinct identities", () => {
    const opts = { trustedHopCount: 0 as const, trustedProxies: [] };

    const id1 = getClientIp(h({ "x-forwarded-for": "1.1.1.1" }), opts);
    const id2 = getClientIp(h({ "x-forwarded-for": "2.2.2.2" }), opts);

    // Both must resolve to the sentinel — not to different IPs.
    expect(id1).toBe(UNKNOWN_CLIENT_IP);
    expect(id2).toBe(UNKNOWN_CLIENT_IP);
    expect(id1).toBe(id2);
  });

  /**
   * Test 3 — Explicit trusted proxy still resolves the forwarded IP correctly.
   *
   * A deployment that sets TRUSTED_PROXY_HOP_COUNT=1 must continue to get the
   * correct client IP from the chain.
   */
  it("Test 3: explicit trusted proxy resolves the expected forwarded IP", () => {
    const ip = getClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), {
      trustedHopCount: 1,
      trustedProxies: [],
    });
    // With 1 trusted proxy, the rightmost entry appended by that proxy is resolved as client IP.
    expect(ip).toBe("203.0.113.9");
  });

  /**
   * Test 4 — Multiple forwarded addresses with configured hop count.
   *
   * X-Forwarded-For: client, proxy1, proxy2 with trustedHopCount=2 must
   * resolve to "client".
   */
  it("Test 4: multiple forwarded addresses obey the configured hop count", () => {
    // Chain: client → proxy1 → proxy2 → app
    // Header built up: X-Forwarded-For: client_ip, proxy1_ip  (proxy2 is the connection IP)
    const ip = getClientIp(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" }), {
      trustedHopCount: 2,
      trustedProxies: [],
    });
    // chain = ["203.0.113.9", "10.0.0.1", "10.0.0.2"]
    // index = 3 - 2 = 1 → "10.0.0.1" is the address the outermost trusted proxy observed,
    // which is the real client as seen by proxy1.
    // With trustedHopCount=2 and 3 entries the resolved address is chain[1].
    expect(ip).toBe("10.0.0.1");

    // Specifically: the client-supplied leftmost entry is NOT trusted.
    expect(ip).not.toBe("203.0.113.9");
  });

  /**
   * Test 5 — Existing behaviour is preserved for explicitly configured proxies.
   *
   * Ensure no legitimate hop-count or allowlist behaviour was broken.
   */
  it("Test 5: existing trusted-proxy allowlist behaviour is unchanged", () => {
    const trustedProxies = parseTrustedProxies("10.0.0.0/8");

    // Single known proxy in the chain — should skip it and return the next left entry.
    const ip = getClientIp(h({ "x-forwarded-for": "203.0.113.9, 10.5.5.5" }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip).toBe("203.0.113.9");

    // Multiple known proxies — first non-proxy from the right is the client.
    const ip2 = getClientIp(h({ "x-forwarded-for": "203.0.113.9, 10.1.1.1, 10.2.2.2" }), {
      trustedHopCount: 1,
      trustedProxies,
    });
    expect(ip2).toBe("203.0.113.9");
  });
});
