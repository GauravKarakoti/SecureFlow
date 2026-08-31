/**
 * Redaction for anything a finding carries out of the scanner.
 *
 * This is the last thing standing between a credential found in a repository
 * and a pull request comment that everyone with read access can see.
 *
 * Refinements (#591, #669):
 *  1. Expanded provider-specific secret patterns (GitLab, Azure, Vault, Discord, HuggingFace, Datadog, Bearer/Basic headers).
 *  2. False positive mitigation (UUIDs, hex color codes, SVG paths, tailwind/CSS classes, word-based long identifiers, mock/test placeholders, safe environment variables).
 *  3. Enhanced Shannon entropy and character-class distribution analysis.
 *  4. Transparent auditing helper `auditSecretMasking` for finding inspection and observability.
 */

/** Kept verbatim: it is asserted on in tests and appears in stored findings. */
export const REDACTION_PLACEHOLDER = '[REDACTED_BY_THE_PROFESSOR]';

export interface MaskRule {
  /** Stable identifier, so a test can name the rule it is exercising. */
  id: string;
  pattern: RegExp;
  /** Defaults to replacing the whole match with the placeholder. */
  replace?: (match: string, ...groups: string[]) => string;
}

/**
 * Values that are obviously not credentials, so an assignment carrying one is
 * left alone.
 */
export const NON_SECRET_VALUE =
  /^(?:process\.env\b|import\.meta(?:\.env)?\b|os\.(?:environ|getenv)\b|System\.getenv\b|Deno\.env\b|getenv\b|config\.(?:get|has)\b|secrets?\.\w+|vault\.\w+|env::var\b|\$\{|<|your[_-]|actual[_-]|placeholder|changeme|change[_-]me|replace[_-]me|xxx+|todo|none|null|undefined|true|false|0|1|""|''|localhost|127\.0\.0\.1|0\.0\.0\.0|mock[_-]|fake[_-]|dummy[_-]|sample[_-]|example[_-]|test[_-]|temp[_-]|insert[_-]|your-api-key|YOUR_SECRET_KEY|CHANGEME)/i;

/**
 * Identifier fragments that mark an assignment as secret-bearing.
 */
const SECRET_NAME =
  '(?:key|secret|token|password|passwd|pwd|credential|auth|apikey|api_key|private_key|access_key|client_secret|signing_key|encryption_key|refresh_token|id_token|access_token|webhook_secret|master_key)';

/**
 * Common non-secret UUID pattern to exclude from entropy redaction.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Color and CSS class tokens to exclude from entropy redaction.
 */
const COLOR_OR_CSS_TOKEN_REGEX = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|(?:bg|text|border|p|m|gap|flex|grid|col|row|rounded|shadow|w|h)-[a-z0-9/_-]+)$/i;

const RULES: readonly MaskRule[] = [
  // ── Connection strings ───────────────────────────────────────────────────
  {
    id: 'db-uri-password',
    pattern:
      /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqp|amqps|ftp|ssh|smtp|clickhouse|cassandra):\/\/[^/\s:]+:)([^/\s@]+)(@)/gi,
    replace: (_m, prefix, _pwd, at) => `${prefix}${REDACTION_PLACEHOLDER}${at}`,
  },
  {
    id: 'internal-ip-address',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replace: () => '[REDACTED_BY_THE_PROFESSOR:IP_ADDR]',
  },
  {
    id: 'internal-domain-url',
    pattern: /(https?:\/\/)(?:[a-zA-Z0-9-]+\.)*(?:internal|local|corp|private|lan|cluster\.local)(?::\d+)?(\/[^\s"']*)?/gi,
    replace: (_m, scheme, _domain, path) => `${scheme}[REDACTED_BY_THE_PROFESSOR:INTERNAL_URL]${path || ''}`,
  },
  {
    id: 'url-userinfo',
    pattern: /(:\/\/[^@\s/]*:)([^@\s/]+)(@)/g,
    replace: (_m, prefix, _pwd, at) => `${prefix}${REDACTION_PLACEHOLDER}${at}`,
  },
  {
    id: 'adonet-connection-string',
    pattern: /((?:password|pwd)\s*=\s*)([^;\s"']+)/gi,
    replace: (match, prefix: string, value: string) =>
      NON_SECRET_VALUE.test(value) ? match : `${prefix}${REDACTION_PLACEHOLDER}`,
  },
  {
    id: 'azure-storage-connection-string',
    pattern: /(AccountKey=)([a-zA-Z0-9+/]{86}==)/gi,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },

  // ── Private keys ─────────────────────────────────────────────────────────
  {
    id: 'pem-private-key',
    pattern:
      /(-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)[\s\S]*?(-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/g,
    replace: (_m, begin, end) => `${begin}\n${REDACTION_PLACEHOLDER}\n${end}`,
  },
  {
    id: 'pem-private-key-unterminated',
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?![\s\S]*-----END)[\s\S]*/g,
  },

  // ── Provider-prefixed keys, most specific first ──────────────────────────
  { id: 'anthropic', pattern: /sk-ant-api\d*-[a-zA-Z0-9-_]{20,}/g },
  { id: 'openai-project', pattern: /sk-proj-[a-zA-Z0-9-_]{20,}/g },
  { id: 'openai', pattern: /sk-[a-zA-Z0-9-_]{32,}/g },
  { id: 'github-pat-fine-grained', pattern: /github_pat_[a-zA-Z0-9_]{22,}/g },
  { id: 'github-pat-classic', pattern: /ghp_[a-zA-Z0-9]{36,}/g },
  { id: 'github-token', pattern: /gh[oprsu]_[a-zA-Z0-9]{36,}/g },
  { id: 'gitlab-pat', pattern: /glpat-[a-zA-Z0-9\-_]{20,}/g },
  { id: 'gitlab-pipeline-token', pattern: /glcbt-[a-zA-Z0-9\-_]{20,}/g },
  { id: 'gitlab-deploy-token', pattern: /gldt-[a-zA-Z0-9\-_]{20,}/g },
  { id: 'hashicorp-vault-token', pattern: /(?:hvs\.[a-zA-Z0-9_-]{24,}|s\.[a-zA-Z0-9_-]{24,})/g },
  { id: 'huggingface-token', pattern: /hf_[a-zA-Z0-9]{34,}/g },
  { id: 'discord-bot-token', pattern: /(?:Bot\s+|discord\s*[:=]\s*['"]?)[MNO][a-zA-Z0-9_-]{23,25}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,38}/g },
  { id: 'datadog-api-key', pattern: /(?:DD_API_KEY|datadog_api_key)\s*[:=]\s*['"]?([a-f0-9]{32})['"]?/gi,
    replace: (match, token: string) => match.replace(token, REDACTION_PLACEHOLDER)
  },
  { id: 'stripe', pattern: /[sr]k_(?:live|test)_[a-zA-Z0-9]{24,}/g },
  { id: 'slack', pattern: /xox[baprse]-[a-zA-Z0-9-]{10,}/g },
  {
    id: 'slack-webhook',
    pattern: /(?<![\w.-])https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\-/]+/g,
  },
  { id: 'aws-access-key-id', pattern: /(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/g },
  { id: 'google-api-key', pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  { id: 'sendgrid', pattern: /SG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}/g },
  { id: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/g },
  { id: 'twilio', pattern: /(?:AC|SK)[a-f0-9]{32}/g },
  { id: 'jwt', pattern: /eyJ[a-zA-Z0-9-_]{8,}\.[a-zA-Z0-9-_]{8,}\.[a-zA-Z0-9-_]+/g },
  { id: 'jwt-header-only', pattern: /eyJhbGciOi[a-zA-Z0-9-_]{20,}/g },

  // ── Authorization Headers ────────────────────────────────────────────────
  {
    id: 'auth-header-bearer',
    pattern: /((?:Authorization|Proxy-Authorization)\s*:\s*Bearer\s+)([a-zA-Z0-9\-_.+/=]{20,})/gi,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },
  {
    id: 'auth-header-basic',
    pattern: /((?:Authorization|Proxy-Authorization)\s*:\s*Basic\s+)([a-zA-Z0-9+/=]{16,})/gi,
    replace: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },

  // ── Generic assignments ──────────────────────────────────────────────────
  {
    id: 'quoted-secret-assignment',
    pattern: new RegExp(
      `([\\w.$\\[\\]'"-]*${SECRET_NAME}[\\w.$\\[\\]'"-]*\\s*[:=]\\s*)(["'\`])([^"'\`\\n]{4,})\\2`,
      'gi',
    ),
    replace: (match, prefix: string, quote: string, value: string) =>
      NON_SECRET_VALUE.test(value.trim()) ? match : `${prefix}${quote}${REDACTION_PLACEHOLDER}${quote}`,
  },
  {
    id: 'bare-secret-assignment',
    pattern: new RegExp(`([\\w.$-]*${SECRET_NAME}[\\w.$-]*=)([^\\s"'\`;,)]{4,})`, 'gi'),
    replace: (match, prefix: string, value: string) =>
      NON_SECRET_VALUE.test(value.trim()) ? match : `${prefix}${REDACTION_PLACEHOLDER}`,
  },
];

/** Minimum length before a token is considered for the entropy check. */
const ENTROPY_MIN_LENGTH = 24;

/** Shannon entropy in bits per character threshold. */
const ENTROPY_THRESHOLD = 3.5;

/** Characters a credential candidate is built from. */
const ENTROPY_CANDIDATE = /[A-Za-z0-9+=_-]{24,}/g;

/** Shannon entropy of `value`, in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;

  const frequencies = new Map<string, number>();
  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Checks if a candidate token consists predominantly of English word fragments
 * (e.g. camelCase identifier or hyphenated words) rather than high-entropy secret bits.
 */
export function isWordBasedIdentifier(token: string): boolean {
  if (!token || token.length < 16) return false;

  // If token has typical word syllables or camelCase transitions without random symbol entropy
  const words = token.split(/(?=[A-Z])|[_-]/).filter(Boolean);
  if (words.length >= 3) {
    const allWordLike = words.every(w => w.length >= 2 && /^[a-zA-Z]+$/.test(w));
    if (allWordLike) return true;
  }

  // Count vowel ratio in purely alphabetic tokens
  if (/^[a-zA-Z]+$/.test(token)) {
    const vowels = (token.match(/[aeiouyAEIOUY]/g) || []).length;
    const vowelRatio = vowels / token.length;
    if (vowelRatio >= 0.28 && vowelRatio <= 0.65) {
      return true;
    }
  }

  return false;
}

/**
 * Whether `token` looks like credential material rather than a long name or safe token.
 */
export function looksLikeCredential(token: string): boolean {
  if (!token || token.length < ENTROPY_MIN_LENGTH) return false;

  // Filter known non-secret false positives
  if (UUID_REGEX.test(token)) return false;
  if (COLOR_OR_CSS_TOKEN_REGEX.test(token)) return false;
  if (NON_SECRET_VALUE.test(token)) return false;
  if (isWordBasedIdentifier(token)) return false;

  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);

  const isLongHex = token.length >= 32 && /^[a-f0-9]+$/i.test(token);
  const isMixedAlphanumeric = hasDigit && hasLower && hasUpper;
  const isBase64Blob = token.length >= 32 && /[+=]/.test(token) && (hasLower || hasUpper);

  if (!isLongHex && !isMixedAlphanumeric && !isBase64Blob) return false;

  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

/**
 * Redact high-entropy tokens the named rules did not recognise.
 */
export function maskHighEntropyTokens(text: string): string {
  if (!text) return text;

  return text.replace(ENTROPY_CANDIDATE, (token) =>
    looksLikeCredential(token) ? REDACTION_PLACEHOLDER : token,
  );
}

/**
 * Apply the named rules only.
 */
export function maskKnownSecretFormats(text: string): string {
  if (!text) return text;

  let sanitized = text;
  for (const rule of RULES) {
    sanitized = rule.replace
      ? sanitized.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string)
      : sanitized.replace(rule.pattern, REDACTION_PLACEHOLDER);
  }

  return sanitized;
}

/**
 * Redact known secret formats and high-entropy strings.
 */
export function maskSecrets(text: string): string {
  if (!text) return text;
  return maskHighEntropyTokens(maskKnownSecretFormats(text));
}

/**
 * The full pass for anything a finding carries out of the scanner.
 */
export function maskFindingText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return maskSecrets(text);
}

export interface SecretMaskingAuditResult {
  originalText: string;
  maskedText: string;
  containsMaskedSecrets: boolean;
  appliedRuleIds: string[];
  entropyRedactedTokenCount: number;
}

/**
 * Audit and inspect secret masking application for a given text snippet.
 */
export function auditSecretMasking(text: string): SecretMaskingAuditResult {
  if (!text) {
    return {
      originalText: '',
      maskedText: '',
      containsMaskedSecrets: false,
      appliedRuleIds: [],
      entropyRedactedTokenCount: 0,
    };
  }

  const appliedRuleIds: string[] = [];
  let intermediate = text;

  for (const rule of RULES) {
    const before = intermediate;
    intermediate = rule.replace
      ? intermediate.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string)
      : intermediate.replace(rule.pattern, REDACTION_PLACEHOLDER);

    if (intermediate !== before) {
      appliedRuleIds.push(rule.id);
    }
  }

  let entropyTokens = 0;
  const finalMasked = intermediate.replace(ENTROPY_CANDIDATE, (token) => {
    if (looksLikeCredential(token)) {
      entropyTokens++;
      return REDACTION_PLACEHOLDER;
    }
    return token;
  });

  return {
    originalText: text,
    maskedText: finalMasked,
    containsMaskedSecrets: finalMasked.includes(REDACTION_PLACEHOLDER),
    appliedRuleIds,
    entropyRedactedTokenCount: entropyTokens,
  };
}

/**
 * Pre-computation masking layer for incoming file diffs and snippets.
 * Ensures hardcoded secrets, proprietary variables, and credentials are obfuscated
 * before transmitting content to third-party LLMs or enterprise endpoints.
 */
export function maskIngressFileContent(fileContent: string, options?: {
  enableEntropyScrubbing?: boolean;
  enableRegexRedaction?: boolean;
  enableTargetedContextIsolation?: boolean;
}): string {
  if (!fileContent) return fileContent;

  const opts = {
    enableEntropyScrubbing: true,
    enableRegexRedaction: true,
    enableTargetedContextIsolation: false,
    ...options,
  };

  let processed = fileContent;

  if (opts.enableRegexRedaction) {
    processed = maskKnownSecretFormats(processed);
  }

  if (opts.enableEntropyScrubbing) {
    processed = maskHighEntropyTokens(processed);
  }

  if (opts.enableTargetedContextIsolation) {
    // Isolate function definitions, class definitions, exported entities, or changed hunks
    const lines = processed.split('\n');
    const targetedLines = lines.filter(line => 
      line.startsWith('+') || 
      line.startsWith('-') || 
      line.startsWith('@@') || 
      /^\s*(?:export|function|const|let|var|class|interface|type|public|private|async)\b/.test(line)
    );
    if (targetedLines.length > 0) {
      processed = targetedLines.join('\n');
    }
  }

  return processed;
}

