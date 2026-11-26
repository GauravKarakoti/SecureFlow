/**
 * Deterministic Sensitive Filename Detection Rules (#2092)
 *
 * Checks the list of **added** (new) files against documented sensitive name and
 * extension patterns. Reports a finding when a secret key, certificate, database dump,
 * env file, or similar sensitive file is committed to the repository.
 *
 * "Example" and documentation variants (`.env.example`, `.env.sample`, `*.example.pem`)
 * are explicitly excluded.
 *
 * Rules can be disabled per-repository via `.secureflow.json` using
 * `disabledRules: ["SEC_SENSITIVE_FILE_NAME"]`.
 *
 * Custom exceptions can be added via `allowedFilenames` or `allowedPatterns` in options.
 */

import { computeDynamicFingerprint, computeFingerprint } from "@/lib/armor/fingerprint";
import type { FileChange, ScanFinding } from "@/lib/armor/scanner";

export const SENSITIVE_FILE_RULE_IDS = {
  SENSITIVE_FILE_NAME: "SEC_SENSITIVE_FILE_NAME",
} as const;

export type SensitiveFileRuleId =
  (typeof SENSITIVE_FILE_RULE_IDS)[keyof typeof SENSITIVE_FILE_RULE_IDS];

// ─── Sensitive patterns ───────────────────────────────────────────────────────

/** Extensions that indicate private keys, certificates, or sensitive credentials. */
export const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".p8",
  ".ppk",
  ".der",
  ".crt",
  ".cer",
  ".jks", // Java KeyStore
  ".keystore",
  ".bks", // Bouncy Castle KeyStore
  ".pub", // might be a public key — still worth flagging if placed in repo root
  ".ovpn", // OpenVPN config with embedded key
  ".asc", // ASCII-armored GPG key
]);

/** Extensions that indicate database dumps or large data files. */
export const DATABASE_DUMP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".sql",
  ".dump",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".mdf",
  ".ldf",
  ".bak",
  ".rdb", // Redis RDB dump
]);

/** Exact filenames and basename prefixes known to be sensitive. */
export const SENSITIVE_EXACT_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".envrc",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  ".env.test",
  ".env.prod",
  ".env.ci",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa_pub",
  ".htpasswd",
  ".netrc",
  ".npmrc", // may contain auth tokens
  ".pypirc", // PyPI credentials
  "credentials", // AWS credentials file
  ".aws/credentials",
  ".ssh/config",
  ".ssh/known_hosts",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "service-account.json",
  "serviceaccount.json",
  "gcp-key.json",
  "firebase-adminsdk.json",
  "google-credentials.json",
]);

/** Partial name patterns (basename contains this substring, case-insensitive). */
export const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\.|$)/, // .env, .env.local, etc.
  /\bpassword[s]?\b/i,
  /\bsecret[s]?\b/i,
  /\bcredential[s]?\b/i,
  /\bprivate[_-]?key\b/i,
  /\bapi[_-]?key[s]?\b/i,
  /\baccess[_-]?token[s]?\b/i,
  /\bauth[_-]?token[s]?\b/i,
  /\b(id_rsa|id_dsa|id_ecdsa|id_ed25519)\b/i,
];

/** Suffixes that mark a file as an example/sample template — these are SAFE. */
export const EXAMPLE_SUFFIXES: readonly string[] = [
  ".example",
  ".sample",
  ".template",
  ".demo",
  ".placeholder",
  ".skeleton",
  ".dist",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBasename(filename: string): string {
  return filename.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? filename.toLowerCase();
}

function getExtension(filename: string): string {
  const base = getBasename(filename);
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx < 0) return "";
  return base.slice(dotIdx);
}

/** Returns true if the file looks like an example/sample template. */
export function isExampleFile(filename: string): boolean {
  const base = getBasename(filename);
  for (const suffix of EXAMPLE_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
    // e.g. `.env.example` → ends with `.example`
    if (base.includes(suffix + ".") || base.includes(suffix + "_")) return true;
  }
  return false;
}

/** Returns true if the filename matches any sensitive pattern. */
export function isSensitiveFilename(
  filename: string,
  allowedFilenames?: string[],
  allowedPatterns?: string[],
): { sensitive: boolean; reason: string } {
  const base = getBasename(filename);
  const ext = getExtension(filename);
  const normalized = filename.replace(/\\/g, "/").toLowerCase();

  // Example/sample files are always safe, check first
  if (isExampleFile(filename)) {
    return { sensitive: false, reason: "example/sample file" };
  }

  // Check allow-list
  if (allowedFilenames?.some((f) => base === f.toLowerCase())) {
    return { sensitive: false, reason: "allow-listed" };
  }
  if (
    allowedPatterns?.some((p) => {
      const pat = p.replace(/\\/g, "/").toLowerCase();
      if (pat.endsWith("/**")) return normalized.startsWith(pat.slice(0, -3));
      if (pat.startsWith("*.")) return base.endsWith(pat.slice(1));
      return normalized.includes(pat);
    })
  ) {
    return { sensitive: false, reason: "allow-listed" };
  }

  // Exact filename match
  if (SENSITIVE_EXACT_NAMES.has(base) || SENSITIVE_EXACT_NAMES.has(normalized)) {
    return { sensitive: true, reason: `Exact filename match: '${base}'` };
  }

  // Extension match (key/cert/db files)
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return { sensitive: true, reason: `Sensitive extension: '${ext}'` };
  }
  if (DATABASE_DUMP_EXTENSIONS.has(ext)) {
    return { sensitive: true, reason: `Database dump extension: '${ext}'` };
  }

  // Pattern match
  for (const pattern of SENSITIVE_NAME_PATTERNS) {
    if (pattern.test(base)) {
      return { sensitive: true, reason: `Basename pattern match: ${pattern.toString()}` };
    }
  }

  return { sensitive: false, reason: "" };
}

// ─── Options / API ────────────────────────────────────────────────────────────

export interface SensitiveFileRuleOptions {
  repositoryId?: string;
  enabled?: boolean;
  disabledRules?: string[];
  /** Exact basenames to allow (not flagged). */
  allowedFilenames?: string[];
  /** Glob-like path patterns to allow (not flagged). */
  allowedPatterns?: string[];
}

/**
 * Checks whether a newly added file is sensitive (#2092).
 * Uses filename only — no patch content is inspected.
 */
export function checkFileForSensitiveName(
  file: FileChange,
  options: SensitiveFileRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];

  const disabledSet = new Set(options.disabledRules ?? []);
  if (disabledSet.has(SENSITIVE_FILE_RULE_IDS.SENSITIVE_FILE_NAME)) return [];

  // Only inspect if the file appears to be newly added (patch starts with "new file mode" or all additions)
  const patch = file.patch ?? "";
  const isNewFile =
    patch.startsWith("new file mode") || (patch.includes("@@") && !patch.includes("\n-"));

  // Even for changed files, the name alone is a risk signal — flag regardless
  if (isExampleFile(file.filename)) return [];

  const result = isSensitiveFilename(
    file.filename,
    options.allowedFilenames,
    options.allowedPatterns,
  );
  if (!result.sensitive) return [];

  const repositoryId = options.repositoryId ?? "default-repo";
  const base = getBasename(file.filename);
  const description =
    `Sensitive file detected: '${file.filename}'. ${result.reason}. ` +
    `Committing secret keys, certificates, environment files, or database dumps exposes credentials and may require a full secrets rotation. ` +
    (isNewFile ? "This appears to be a newly added file." : "");

  const oneLineFix =
    `Remove '${file.filename}' from git history (use git-filter-repo or BFG Repo Cleaner), ` +
    `rotate any exposed credentials, and store secrets in a secrets manager or CI/CD vault. ` +
    `Add '${base}' to .gitignore.`;

  const fp = computeFingerprint(repositoryId, file.filename, "Sensitive File Name", base);
  const dynFp = computeDynamicFingerprint(repositoryId, file.filename, "Sensitive File Name", base);

  return [
    {
      type: "Sensitive File Name",
      severity: "HIGH",
      description: `[${SENSITIVE_FILE_RULE_IDS.SENSITIVE_FILE_NAME}] ${description}`,
      fileLocation: file.filename,
      lineStart: 1,
      lineEnd: 1,
      codeSnippet: file.filename,
      remediation: oneLineFix,
      fingerprint: fp,
      dynamicFingerprint: dynFp.fingerprint,
      matchedSignatures: [SENSITIVE_FILE_RULE_IDS.SENSITIVE_FILE_NAME],
      confidence: "HIGH",
      confidenceReason: `Sensitive filename: ${result.reason}`,
    },
  ];
}

/**
 * Runs sensitive filename checks across all changed files (#2092).
 */
export function runSensitiveFileRules(
  files: FileChange[],
  options: SensitiveFileRuleOptions = {},
): ScanFinding[] {
  if (options.enabled === false) return [];
  const findings: ScanFinding[] = [];
  for (const file of files) {
    findings.push(...checkFileForSensitiveName(file, options));
  }
  return findings;
}
