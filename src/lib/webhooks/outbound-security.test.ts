import { describe, it, expect } from "vitest";
import { isBlockedIPv4, isBlockedIPv6, validateOutboundWebhookUrl } from "./outbound-security";

describe("Outbound Webhook SSRF & Address Security (#1866)", () => {
  describe("isBlockedIPv4", () => {
    it("blocks loopback (127.0.0.0/8)", () => {
      expect(isBlockedIPv4("127.0.0.1")).toBe(true);
      expect(isBlockedIPv4("127.1.2.3")).toBe(true);
      expect(isBlockedIPv4("127.255.255.255")).toBe(true);
    });

    it("blocks current network / 0.0.0.0", () => {
      expect(isBlockedIPv4("0.0.0.0")).toBe(true);
      expect(isBlockedIPv4("0.1.2.3")).toBe(true);
    });

    it("blocks RFC 1918 private subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", () => {
      expect(isBlockedIPv4("10.0.0.1")).toBe(true);
      expect(isBlockedIPv4("10.254.254.254")).toBe(true);
      expect(isBlockedIPv4("172.16.0.1")).toBe(true);
      expect(isBlockedIPv4("172.31.255.255")).toBe(true);
      expect(isBlockedIPv4("192.168.1.1")).toBe(true);
      expect(isBlockedIPv4("192.168.0.100")).toBe(true);
    });

    it("allows public IPv4 addresses", () => {
      expect(isBlockedIPv4("8.8.8.8")).toBe(false);
      expect(isBlockedIPv4("1.1.1.1")).toBe(false);
      expect(isBlockedIPv4("140.82.121.4")).toBe(false);
      expect(isBlockedIPv4("172.15.255.255")).toBe(false);
      expect(isBlockedIPv4("172.32.0.1")).toBe(false);
    });

    it("blocks link-local / cloud metadata (169.254.0.0/16)", () => {
      expect(isBlockedIPv4("169.254.169.254")).toBe(true);
      expect(isBlockedIPv4("169.254.1.1")).toBe(true);
    });

    it("blocks carrier-grade NAT (100.64.0.0/10)", () => {
      expect(isBlockedIPv4("100.64.0.1")).toBe(true);
      expect(isBlockedIPv4("100.127.255.255")).toBe(true);
      expect(isBlockedIPv4("100.63.255.255")).toBe(false);
      expect(isBlockedIPv4("100.128.0.1")).toBe(false);
    });

    it("blocks multicast and broadcast", () => {
      expect(isBlockedIPv4("224.0.0.1")).toBe(true);
      expect(isBlockedIPv4("239.255.255.255")).toBe(true);
      expect(isBlockedIPv4("255.255.255.255")).toBe(true);
    });
  });

  describe("isBlockedIPv6", () => {
    it("blocks IPv6 loopback (::1)", () => {
      expect(isBlockedIPv6("::1")).toBe(true);
      expect(isBlockedIPv6("[::1]")).toBe(true);
      expect(isBlockedIPv6("0:0:0:0:0:0:0:1")).toBe(true);
    });

    it("blocks IPv6 link-local (fe80::/10)", () => {
      expect(isBlockedIPv6("fe80::1")).toBe(true);
      expect(isBlockedIPv6("fe80:0:0:0:0:0:0:1")).toBe(true);
      expect(isBlockedIPv6("febf::ffff")).toBe(true);
    });

    it("blocks unique local addresses (fc00::/7)", () => {
      expect(isBlockedIPv6("fc00::1")).toBe(true);
      expect(isBlockedIPv6("fd12:3456:789a::1")).toBe(true);
    });

    it("blocks IPv4-mapped IPv6 pointing to private addresses", () => {
      expect(isBlockedIPv6("::ffff:127.0.0.1")).toBe(true);
      expect(isBlockedIPv6("::ffff:10.0.0.1")).toBe(true);
      expect(isBlockedIPv6("::ffff:192.168.1.1")).toBe(true);
      expect(isBlockedIPv6("::ffff:8.8.8.8")).toBe(false);
    });

    it("allows public IPv6 addresses", () => {
      expect(isBlockedIPv6("2606:4700:4700::1111")).toBe(false);
      expect(isBlockedIPv6("2001:4860:4860::8888")).toBe(false);
    });
  });

  describe("validateOutboundWebhookUrl", () => {
    it("rejects non-https schemes", async () => {
      const res = await validateOutboundWebhookUrl("http://example.com/webhook", {
        resolveDns: false,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("must use https:");
    });

    it("rejects embedded credentials", async () => {
      const res = await validateOutboundWebhookUrl("https://admin:pass@example.com/webhook", {
        resolveDns: false,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("embedded credentials");
    });

    it("rejects loopback hostnames", async () => {
      for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) {
        const res = await validateOutboundWebhookUrl(`https://${host}/webhook`, {
          resolveDns: false,
        });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/loopback|blocked/i);
      }
    });

    it("rejects internal TLDs (.local, .internal, .lan, .corp, etc.)", async () => {
      for (const tld of [".local", ".internal", ".lan", ".corp", ".cluster.local"]) {
        const res = await validateOutboundWebhookUrl(`https://myservice${tld}/hook`, {
          resolveDns: false,
        });
        expect(res.ok).toBe(false);
        expect(res.error).toContain("domain cannot end with");
      }
    });

    it("rejects private and link-local IP hostnames", async () => {
      const targets = [
        "https://10.0.0.1/hook",
        "https://172.20.0.1/hook",
        "https://192.168.0.1/hook",
        "https://169.254.169.254/hook",
      ];
      for (const target of targets) {
        const res = await validateOutboundWebhookUrl(target, { resolveDns: false });
        expect(res.ok).toBe(false);
        expect(res.error).toContain("private, loopback, or link-local");
      }
    });

    it("rejects domains that resolve to private IPs during DNS lookup", async () => {
      const mockDns = async () => ["10.0.1.5"];
      const res = await validateOutboundWebhookUrl("https://internal-portal.example.com/hook", {
        dnsLookup: mockDns,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("resolves to a blocked or private IP address");
    });

    it("accepts valid public HTTPS endpoints", async () => {
      const mockDns = async () => ["93.184.216.34"];
      const res = await validateOutboundWebhookUrl("https://example.com/api/webhook", {
        dnsLookup: mockDns,
      });
      expect(res.ok).toBe(true);
      expect(res.url?.hostname).toBe("example.com");
      expect(res.url?.pathname).toBe("/api/webhook");
    });
  });
});
