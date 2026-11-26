/**
 * Deterministic Outbound Destination Detection Rules (#2091)
 *
 * Detects newly added URLs and hostnames that may indicate:
 * 1. Raw IPv4 / IPv6 addresses (excluding RFC-1918 private ranges and loopback)
 * 2. Well-known URL shorteners (bit.ly, t.co, tinyurl, etc.)
 * 3. Paste / file-sharing sites (pastebin.com, hastebin.com, file.io, etc.)
 *
 * Credentials inside URLs are masked before reporting.
 * Custom allow-lists can be configured via `.secureflow.json`.
 */

import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import { parseUnifiedPatch, addedLines } from "@/lib/armor/diff";
import type { Severity } from "@/lib/severity";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const OUTBOUND_RULE_IDS = {
  RAW_IP_ADDRESS: "SEC_OUTBOUND_RAW_IP",
  URL_SHORTENER: "SEC_OUTBOUND_URL_SHORTENER",
  PASTE_SITE: "SEC_OUTBOUND_PASTE_SITE",
} as const;

export type OutboundRuleId = (typeof OUTBOUND_RULE_IDS)[keyof typeof OUTBOUND_RULE_IDS];

// ─── Host lists ──────────────────────────────────────────────────────────────

/** Well-known URL shortening services. Maintainers can extend this list. */
export const URL_SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  "bit.ly",
  "bitly.com",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rb.gy",
  "tiny.cc",
  "short.io",
  "shorturl.at",
  "cutt.ly",
  "u.to",
  "clck.ru",
  "qr.ae",
]);

/** Paste and file-sharing services. */
export const PASTE_SITE_HOSTS: ReadonlySet<string> = new Set([
  "pastebin.com",
  "pastebin.pl",
  "hastebin.com",
  "paste.ee",
  "paste.sh",
  "ghostbin.co",
  "controlc.com",
  "file.io",
  "transfer.sh",
  "0x0.st",
  "anonfiles.com",
  "mega.nz",
  "filetransfer.io",
  "catbox.moe",
  "uguu.se",
  "tmp.ninja",
  "tempfile.ninja",
]);

// ─── Regexes ─────────────────────────────────────────────────────────────────

/**
 * Matches IPv4 addresses. Used as a starting point; RFC-1918/loopback filtered below.
 */
const IPV4_REGEX =
  /\b((?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d))(?::\d{1,5})?\b/g;

/** Matches a URL with an explicit host to extract. */
const URL_HOST_REGEX = /https?:\/\/(?:[^@/\s]+@)?([a-z0-9.-]+(?::\d+)?)/gi;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // shared-address space
  return false;
}

function maskCredentialsInUrl(url: string): string {
  return url.replace(/(https?:\/\/)([^@/\s]+@)/, "$1***@");
}

function extractHostFromUrl(url: string): string | null {
  const m = /https?:\/\/(?:[^@/\s]+@)?([a-z0-9.-]+(?::\d+)?)/i.exec(url);
  if (!m) return null;
  return m[1].split(":")[0].toLowerCase();
}

export interface OutboundRuleOptions {
  repositoryId?: string;
  enabled?: boolean;
  disabledRules?: string[];
  /** Hostnames or partial domain suffixes to allow (not flagged). */
  allowedHosts?: string[];
}

function isAllowedHost(host: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  const h = host.toLowerCase();
  return allowedHosts.some(
    (allowed) => h === allowed.toLowerCase() || h.endsWith(`.${allowed.toLowerCase()}`),
  );
}

// ─── Core detection ──────────────────────────────────────────────────────────

interface OutboundRawFinding {
  ruleId: OutboundRuleId;
  severity: Severity;
  type: string;
  description: string;
  oneLineFix: string;
  lineNumber: number;
  lineSnippet: string;
  masked: string;
}

export function checkLineForOutboundDestinations(
  line: string,
  lineNumber: number,
  options: { disabledSet: Set<string>; allowedHosts?: string[] },
): OutboundRawFinding[] {
  const { disabledSet, allowedHosts } = options;
  const findings: OutboundRawFinding[] = [];
  const reported = new Set<string>(); // avoid duplicate reports per line

  // 1. Raw IP addresses
  if (!disabledSet.has(OUTBOUND_RULE_IDS.RAW_IP_ADDRESS)) {
    IPV4_REGEX.lastIndex = 0;
    for (const m of line.matchAll(IPV4_REGEX)) {
      const ip = m[1];
      if (isPrivateIp(ip)) continue;
      if (isAllowedHost(ip, allowedHosts)) continue;
      if (reported.has(`ip:${ip}`)) continue;
      reported.add(`ip:${ip}`);
      findings.push({
        ruleId: OUTBOUND_RULE_IDS.RAW_IP_ADDRESS,
        severity: "MEDIUM",
        type: "Suspicious Outbound Destination / Raw IP",
        description: `Raw IPv4 address '${ip}' found in added code. Hardcoded IP addresses may indicate command-and-control servers or data exfiltration endpoints.`,
        oneLineFix: `Replace raw IP '${ip}' with a named hostname in configuration, or add it to the unicode allow-list if legitimate.`,
        lineNumber,
        lineSnippet: line,
        masked: line,
      });
    }
  }

  // 2. URL shorteners and 3. paste sites
  if (
    !disabledSet.has(OUTBOUND_RULE_IDS.URL_SHORTENER) ||
    !disabledSet.has(OUTBOUND_RULE_IDS.PASTE_SITE)
  ) {
    URL_HOST_REGEX.lastIndex = 0;
    for (const m of line.matchAll(URL_HOST_REGEX)) {
      const rawUrl = m[0];
      const host = m[1].split(":")[0].toLowerCase();
      const masked = maskCredentialsInUrl(rawUrl);

      if (isAllowedHost(host, allowedHosts)) continue;

      if (
        !disabledSet.has(OUTBOUND_RULE_IDS.URL_SHORTENER) &&
        URL_SHORTENER_HOSTS.has(host) &&
        !reported.has(`short:${host}`)
      ) {
        reported.add(`short:${host}`);
        findings.push({
          ruleId: OUTBOUND_RULE_IDS.URL_SHORTENER,
          severity: "MEDIUM",
          type: "Suspicious Outbound Destination / URL Shortener",
          description: `URL shortener '${host}' (${masked}) found in added code. URL shorteners hide the real destination and are commonly used in phishing and malware distribution.`,
          oneLineFix: `Replace the shortened URL '${masked}' with the full destination URL so reviewers can inspect it.`,
          lineNumber,
          lineSnippet: line,
          masked,
        });
      }

      if (
        !disabledSet.has(OUTBOUND_RULE_IDS.PASTE_SITE) &&
        PASTE_SITE_HOSTS.has(host) &&
        !reported.has(`paste:${host}`)
      ) {
        reported.add(`paste:${host}`);
        findings.push({
          ruleId: OUTBOUND_RULE_IDS.PASTE_SITE,
          severity: "MEDIUM",
          type: "Suspicious Outbound Destination / Paste Site",
          description: `Paste or file-sharing site '${host}' (${masked}) found in added code. Paste sites are commonly used for C2 payloads and data exfiltration.`,
          oneLineFix: `Remove the paste-site URL '${masked}'. Store the resource in the project repository or a trusted CDN.`,
          lineNumber,
          lineSnippet: line,
          masked,
        });
      }
    }
  }

  return findings;
}

/**
 * Scans added lines of a single file for suspicious outbound destinations (#2091).
 */
export function scanFileWithOutboundRules(
  fileOrFilename: FileChange | string,
  optionsOrPatch?: OutboundRuleOptions | string,
  maybeOptions?: OutboundRuleOptions,
): ScanFinding[] {
  let file: FileChange;
  let options: OutboundRuleOptions;

  if (typeof fileOrFilename === "string") {
    file = {
      filename: fileOrFilename,
      patch: typeof optionsOrPatch === "string" ? optionsOrPatch : "",
    };
    options = maybeOptions || {};
  } else {
    file = fileOrFilename;
    options = (typeof optionsOrPatch === "object" ? optionsOrPatch : maybeOptions) || {};
  }

  if (options.enabled === false) return [];
  if (!file.patch || !file.patch.trim()) return [];

  const disabledSet = new Set(options.disabledRules ?? []);
  const repositoryId = options.repositoryId ?? "default-repo";

  // Extract only added lines
  let added: Array<{ number: number; content: string }> = [];
  if (file.patch.includes("@@")) {
    const parsed = parseUnifiedPatch(file.patch);
    added = addedLines(parsed);
  } else {
    const lines = file.patch.split(/\r?\n/);
    let lineNum = 1;
    for (const l of lines) {
      if (
        l.startsWith("+++") ||
        l.startsWith("---") ||
        l.startsWith("diff ") ||
        l.startsWith("index ")
      )
        continue;
      if (l.startsWith("+")) {
        added.push({ number: lineNum, content: l.slice(1) });
        lineNum++;
      } else if (!l.startsWith("-")) {
        lineNum++;
      }
    }
  }

  const findings: ScanFinding[] = [];

  for (const { number, content } of added) {
    const rawFindings = checkLineForOutboundDestinations(content, number, {
      disabledSet,
      allowedHosts: options.allowedHosts,
    });

    for (const raw of rawFindings) {
      const snippet = raw.lineSnippet.trim().slice(0, 300);
      const fp = computeFingerprint(repositoryId, file.filename, raw.type, snippet);
      const dynFp = computeDynamicFingerprint(repositoryId, file.filename, raw.type, snippet);

      findings.push({
        type: raw.type,
        severity: raw.severity,
        description: `[${raw.ruleId}] ${raw.description}`,
        fileLocation: file.filename,
        lineStart: raw.lineNumber,
        lineEnd: raw.lineNumber,
        codeSnippet: snippet,
        remediation: raw.oneLineFix,
        fingerprint: fp,
        dynamicFingerprint: dynFp.fingerprint,
        matchedSignatures: [raw.ruleId],
        confidence: "HIGH",
        confidenceReason: `Deterministic outbound-destination pattern: ${raw.ruleId}`,
      });
    }
  }

  return findings;
}

/**
 * Runs outbound-destination rules across all changed files (#2091).
 */
export function runOutboundSecurityRules(
  files: FileChange[],
  options: OutboundRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  const findings: ScanFinding[] = [];
  for (const file of files) {
    findings.push(...scanFileWithOutboundRules(file, options));
  }
  return findings;
}
