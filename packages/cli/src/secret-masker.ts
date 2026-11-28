/**
 * Secret Masking Utilities for SecureFlow CLI Exporters (#2021)
 *
 * Ensures that code snippets, findings, and violation lines never expose
 * raw credentials, private keys, API keys, or high-entropy secrets in exported
 * reports (JUnit XML, Markdown, CSV, HTML, SARIF).
 */

import { calculateShannonEntropy, isBenignSecretCandidate, UUID_REGEX } from "./entropy.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

export interface MaskRule {
  id: string;
  pattern: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
}

const NON_SECRET_VALUE =
  /^(?:process\.env\b|import\.meta(?:\.env)?\b|os\.(?:environ|getenv)\b|System\.getenv\b|Deno\.env\b|getenv\b|config\.(?:get|has)\b|secrets?\.\w+|vault\.\w+|env::var\b|\$\{|<|your[_-]|actual[_-]|placeholder|change[_-]me|replace[_-]me|xxx+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|mock[_-]|fake[_-]|dummy[_-]|sample[_-]|example[_-]|test[_-]|temp[_-]|insert[_-]|your-api-key|YOUR_SECRET_KEY|(?:changeme|todo|none|null|undefined|true|false|0|1|""|'')$)/i;

const SECRET_NAME =
  "(?:key|secret|token|password|passwd|pwd|credential|auth|apikey|api_key|private_key|access_key|client_secret|signing_key|encryption_key|refresh_token|id_token|access_token|webhook_secret|master_key)";

export const KNOWN_SECRET_RULES: MaskRule[] = [
  // Cloud providers & well-known vendors
  { id: "aws-access-key-id", pattern: /(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/g },
  {
    id: "aws-secret-access-key",
    pattern: /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    replace: (m, token) => m.replace(token, REDACTION_PLACEHOLDER),
  },
  { id: "github-token", pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}/g },
  { id: "github-fine-grained", pattern: /github_pat_[A-Za-z0-9_]{82}/g },
  { id: "google-api-key", pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  { id: "stripe", pattern: /[sr]k_(?:live|test)_[a-zA-Z0-9]{24,}/g },
  { id: "slack-token", pattern: /xox[baprse]-[a-zA-Z0-9-]{10,}/g },
  {
    id: "slack-webhook",
    pattern: /(?<![\w.-])https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\-/]+/g,
  },
  { id: "sendgrid", pattern: /SG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}/g },
  { id: "npm-token", pattern: /npm_[A-Za-z0-9]{36}/g },
  { id: "twilio", pattern: /(?:AC|SK)[a-f0-9]{32}/g },
  { id: "gitlab-token", pattern: /glpat-[a-zA-Z0-9\-_]{20,}/g },
  { id: "gitlab-deploy-token", pattern: /gldt-[a-zA-Z0-9\-_]{20,}/g },
  { id: "hashicorp-vault-token", pattern: /(?:hvs\.[a-zA-Z0-9_-]{24,}|s\.[a-zA-Z0-9_-]{24,})/g },
  { id: "huggingface-token", pattern: /hf_[a-zA-Z0-9]{34,}/g },
  { id: "jwt", pattern: /eyJ[a-zA-Z0-9-_]{8,}\.[a-zA-Z0-9-_]{8,}\.[a-zA-Z0-9-_]+/g },
  {
    id: "private-key-header",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },

  // Passwords and license keys passed on QNX build command lines (#2212)
  {
    id: "qnx-software-center-credential",
    pattern:
      /(-(?:myqnx\.password|addLicenseKey)(?:\s+|=))(?!["']?[$%@])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },
  {
    id: "sshpass-password",
    pattern: /(\bsshpass\s+-p\s*)(?!["']?[$%])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },

  // Authorization headers
  {
    id: "auth-header-bearer",
    pattern: /((?:Authorization|Proxy-Authorization)\s*:\s*Bearer\s+)([a-zA-Z0-9\-_.+/=]{20,})/gi,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },
  {
    id: "auth-header-basic",
    pattern: /((?:Authorization|Proxy-Authorization)\s*:\s*Basic\s+)([a-zA-Z0-9+/=]{16,})/gi,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },

  // Generic assignments
  {
    id: "quoted-secret-assignment",
    pattern: new RegExp(
      `([\\w.$\\[\\]'"-]*${SECRET_NAME}[\\w.$\\[\\]'"-]*\\s*[:=]\\s*)(["'\`])([^"'\`\\n]{4,})\\2`,
      "gi",
    ),
    replace: (match, prefix: string, quote: string, value: string) =>
      NON_SECRET_VALUE.test(value.trim())
        ? match
        : `${prefix}${quote}${REDACTION_PLACEHOLDER}${quote}`,
  },
  {
    id: "bare-secret-assignment",
    pattern: new RegExp(`([\\w.$-]*${SECRET_NAME}[\\w.$-]*=)([^\\s"'\`;,)]{4,})`, "gi"),
    replace: (match, prefix: string, value: string) =>
      NON_SECRET_VALUE.test(value.trim()) ? match : `${prefix}${REDACTION_PLACEHOLDER}`,
  },
];

const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_THRESHOLD = 3.6;
const ENTROPY_CANDIDATE = /[A-Za-z0-9+=_-]{20,}/g;

export function looksLikeCredential(token: string): boolean {
  if (!token || token.length < ENTROPY_MIN_LENGTH) return false;
  if (UUID_REGEX.test(token)) return false;
  if (isBenignSecretCandidate(token)) return false;
  if (NON_SECRET_VALUE.test(token)) return false;

  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);

  const isLongHex = token.length >= 32 && /^[a-f0-9]+$/i.test(token);
  const isMixedAlphanumeric = hasDigit && hasLower && hasUpper;
  const isBase64Blob = token.length >= 24 && /[+=]/.test(token) && (hasLower || hasUpper);

  if (!isLongHex && !isMixedAlphanumeric && !isBase64Blob) return false;

  return calculateShannonEntropy(token) >= ENTROPY_THRESHOLD;
}

export function maskHighEntropyTokens(text: string): string {
  if (!text) return text;
  return text.replace(ENTROPY_CANDIDATE, (token) =>
    looksLikeCredential(token) ? REDACTION_PLACEHOLDER : token,
  );
}

export function maskKnownSecretFormats(text: string): string {
  if (!text) return text;
  let sanitized = text;
  for (const rule of KNOWN_SECRET_RULES) {
    sanitized = rule.replace
      ? sanitized.replace(
          rule.pattern,
          rule.replace as (substring: string, ...args: unknown[]) => string,
        )
      : sanitized.replace(rule.pattern, REDACTION_PLACEHOLDER);
  }
  return sanitized;
}

/**
 * Redacts known secret patterns and high-entropy strings from the given text.
 */
export function maskSecrets(text: string): string {
  if (!text) return text;
  return maskHighEntropyTokens(maskKnownSecretFormats(text));
}
