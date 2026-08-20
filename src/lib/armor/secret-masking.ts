/**
 * Redaction for anything a finding carries out of the scanner.
 *
 * This is the last thing standing between a credential found in a repository
 * and a pull request comment that everyone with read access can see. It used to
 * be a wall of sequential `.replace()` calls in `scanner.ts` applied to exactly
 * two fields, under a header comment promising to redact *"high-entropy strings
 * and known secret formats"* — of which only the second half was implemented
 * (#591).
 *
 * Three things changed:
 *
 *  1. **The rules are a declared, ordered table** rather than statements whose
 *     order is accidental. That ordering was load-bearing and quietly wrong:
 *     the `sk-proj-` rule sat *after* the broader `sk-[a-zA-Z0-9-_]{32,}` rule
 *     and could therefore never fire, and the truncated-JWT rule re-scanned
 *     text the full-JWT rule had already replaced.
 *
 *  2. **The shapes that actually matter are covered.** PEM private keys —
 *     arguably the highest-value thing a secret scanner can find — passed
 *     through verbatim, as did every `DB_PASSWORD = "…"` assignment, every
 *     non-URI connection string, and several common provider prefixes.
 *
 *  3. **The entropy pass the comment promised now exists**, guarded so it
 *     redacts credentials rather than long identifiers.
 *
 * `maskSecrets` keeps its old name, signature and behaviour for every input the
 * old rules recognised. {@link maskFindingText} is the fuller pass, and is what
 * the worker applies to the AI-generated `explanation` and `remediation` — the
 * two fields that reached GitHub and Postgres with no redaction at all.
 */

/** Kept verbatim: it is asserted on in tests and appears in stored findings. */
export const REDACTION_PLACEHOLDER = '[REDACTED_BY_THE_PROFESSOR]';

interface MaskRule {
  /** Stable identifier, so a test can name the rule it is exercising. */
  id: string;
  pattern: RegExp;
  /** Defaults to replacing the whole match with the placeholder. */
  replace?: (match: string, ...groups: string[]) => string;
}

/**
 * Values that are obviously not credentials, so an assignment carrying one is
 * left alone.
 *
 * Without this, `const apiKey = process.env.API_KEY` — the *correct* way to
 * handle a secret, and the thing the scanner is trying to encourage — would be
 * redacted as though it were a leak, and the remediation advice would be
 * rendered unreadable.
 */
const NON_SECRET_VALUE =
  /^(?:process\.env\b|import\.meta\b|os\.environ\b|System\.getenv\b|Deno\.env\b|\$\{|<|your[_-]|actual[_-]|placeholder|changeme|change[_-]me|replace[_-]me|xxx+|todo|none|null|undefined|true|false)/i;

/**
 * Identifier fragments that mark an assignment as secret-bearing.
 *
 * The same vocabulary `scrubCredentials` and the audit-log minimiser use, so
 * the three agree on what "looks like a secret" means.
 */
const SECRET_NAME = '(?:key|secret|token|password|passwd|pwd|credential|auth|apikey|api_key|private_key|access_key)';

const RULES: readonly MaskRule[] = [
  // ── Connection strings ───────────────────────────────────────────────────
  // First, because a URI's password would otherwise be partly consumed by the
  // generic assignment rule and left half-visible. The scheme and username are
  // preserved: a reviewer needs to know *which* database leaked.
  {
    id: 'db-uri-password',
    pattern:
      /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqp|amqps|ftp|ssh|smtp|clickhouse|cassandra):\/\/[^/\s:]+:)([^/\s@]+)(@)/gi,
    replace: (_m, prefix, _pwd, at) => `${prefix}${REDACTION_PLACEHOLDER}${at}`,
  },
  {
    id: 'url-userinfo',
    // Any remaining `scheme://user:pass@host`, for schemes the list above does
    // not name. Mirrors the rule `scrubCredentials` applies to log lines.
    pattern: /(:\/\/[^@\s/]*:)([^@\s/]+)(@)/g,
    replace: (_m, prefix, _pwd, at) => `${prefix}${REDACTION_PLACEHOLDER}${at}`,
  },
  {
    id: 'adonet-connection-string',
    // Server=…;User Id=sa;Password=… — the SQL Server / ODBC shape, which is
    // not a URI and so was invisible to the rule above.
    pattern: /((?:password|pwd)\s*=\s*)([^;\s"']+)/gi,
    replace: (match, prefix: string, value: string) =>
      NON_SECRET_VALUE.test(value) ? match : `${prefix}${REDACTION_PLACEHOLDER}`,
  },

  // ── Private keys ─────────────────────────────────────────────────────────
  // The highest-value thing in this file and previously absent entirely. The
  // body is replaced wholesale; the BEGIN/END lines stay so the finding still
  // reads as "a private key was committed here".
  {
    id: 'pem-private-key',
    pattern:
      /(-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)[\s\S]*?(-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/g,
    replace: (_m, begin, end) => `${begin}\n${REDACTION_PLACEHOLDER}\n${end}`,
  },
  {
    id: 'pem-private-key-unterminated',
    // A truncated snippet frequently carries the header and the first lines of
    // the body without the footer. Those lines are still key material.
    //
    // The lookahead is what keeps this from swallowing a block the rule above
    // already handled: without it, this pattern matches from the BEGIN marker
    // to the end of the text and takes both markers — and everything after
    // them — with it.
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?![\s\S]*-----END)[\s\S]*/g,
  },

  // ── Provider-prefixed keys, most specific first ──────────────────────────
  // Ordering is the fix here: `sk-proj-` used to sit below the broader `sk-`
  // rule, which had already consumed the match, so it could never fire.
  { id: 'anthropic', pattern: /sk-ant-api\d*-[a-zA-Z0-9-_]+/g },
  { id: 'openai-project', pattern: /sk-proj-[a-zA-Z0-9-_]{20,}/g },
  { id: 'openai', pattern: /sk-[a-zA-Z0-9-_]{32,}/g },
  { id: 'github-pat-fine-grained', pattern: /github_pat_[a-zA-Z0-9_]{22,}/g },
  { id: 'github-pat-classic', pattern: /ghp_[a-zA-Z0-9]{36,}/g },
  { id: 'github-token', pattern: /gh[oprsu]_[a-zA-Z0-9]{36,}/g },
  { id: 'stripe', pattern: /[sr]k_(?:live|test)_[a-zA-Z0-9]{24,}/g },
  { id: 'slack', pattern: /xox[baprse]-[a-zA-Z0-9-]{10,}/g },
  { id: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { id: 'aws-access-key-id', pattern: /(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/g },
  { id: 'google-api-key', pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  { id: 'sendgrid', pattern: /SG\.[A-Za-z0-9\-_]{16,}\.[A-Za-z0-9\-_]{16,}/g },
  { id: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/g },
  { id: 'twilio', pattern: /(?:AC|SK)[a-f0-9]{32}/g },
  { id: 'jwt', pattern: /eyJ[a-zA-Z0-9-_]{8,}\.[a-zA-Z0-9-_]{8,}\.[a-zA-Z0-9-_]+/g },
  { id: 'jwt-header-only', pattern: /eyJhbGciOi[a-zA-Z0-9-_]{20,}/g },

  // ── Generic assignments ──────────────────────────────────────────────────
  // The shape `scrubCredentials` already proved out, but keeping the variable
  // name visible. `SECRET_KEY = "…"` tells a reviewer far more than
  // `[REDACTED_SECRET]` does, and the name is not the secret.
  {
    id: 'quoted-secret-assignment',
    pattern: new RegExp(
      `([\\w.$\\[\\]'"-]*${SECRET_NAME}[\\w.$\\[\\]'"-]*\\s*[:=]\\s*)(["'\`])([^"'\`\\n]{4,})\\2`,
      'gi',
    ),
    replace: (match, prefix: string, quote: string, value: string) =>
      NON_SECRET_VALUE.test(value) ? match : `${prefix}${quote}${REDACTION_PLACEHOLDER}${quote}`,
  },
  {
    id: 'bare-secret-assignment',
    // The .env shape: no quotes, no spaces around the separator.
    pattern: new RegExp(`([\\w.$-]*${SECRET_NAME}[\\w.$-]*=)([^\\s"'\`;,)]{4,})`, 'gi'),
    replace: (match, prefix: string, value: string) =>
      NON_SECRET_VALUE.test(value) ? match : `${prefix}${REDACTION_PLACEHOLDER}`,
  },
];

/**
 * Minimum length before a token is considered for the entropy check.
 *
 * Short high-entropy strings are overwhelmingly hashes-of-nothing, minified
 * identifiers and hex colours. Real credentials are long.
 */
const ENTROPY_MIN_LENGTH = 24;

/**
 * Shannon entropy in bits per character, above which a token that also passes
 * the character-class test is treated as a credential.
 *
 * 3.5 sits above ordinary prose and camelCase identifiers and below the ~4.5
 * of a base64 or hex secret of this length.
 */
const ENTROPY_THRESHOLD = 3.5;

/**
 * Characters a credential is built from. Anything else ends a candidate.
 *
 * `/` is deliberately absent even though it is in the base64 alphabet. With it
 * included, a candidate runs straight through a URL or a file path —
 * `com/GauravKarakoti/SecureFlow/blob/main/src/lib/armor/scanner` is 60
 * characters of mixed case at ~4 bits, so every long path in every finding came
 * back redacted. Splitting on `/` costs nothing real: a base64 secret long
 * enough to matter still leaves a 24-character run on one side of the slash.
 */
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
 * Whether `token` looks like credential material rather than a long name.
 *
 * Entropy alone is not enough, and getting this wrong in the permissive
 * direction is worse than missing a secret: it would flatten the code the
 * remediation advice is talking about. `developerReceivesAISecurityExplanations`
 * is 39 characters and scores about 3.8 bits — comfortably over the threshold —
 * so a bare entropy check would redact half the identifiers in this repository.
 *
 * The discriminator is character-class mixing. Credentials mix cases with
 * digits, or are long runs of hex; identifiers, however long, do not carry
 * digits, and prose does not stay inside the base64 alphabet.
 */
export function looksLikeCredential(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) return false;

  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);

  const isLongHex = token.length >= 32 && /^[a-f0-9]+$/i.test(token);
  const isMixedAlphanumeric = hasDigit && hasLower && hasUpper;
  // A long base64 blob is frequently single-case with padding; `+` and `=` do
  // not appear in identifiers, so they stand in for the case/digit mix. `/` is
  // excluded for the reason ENTROPY_CANDIDATE documents.
  const isBase64Blob = token.length >= 32 && /[+=]/.test(token) && (hasLower || hasUpper);

  if (!isLongHex && !isMixedAlphanumeric && !isBase64Blob) return false;

  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

/**
 * Redact high-entropy tokens the named rules did not recognise.
 *
 * This is the half of the original header comment that was never implemented.
 * It is what catches a 40-character hex OAuth secret, a 64-character HMAC key
 * or a base64 service-account blob — none of which carries a recognisable
 * prefix, and all of which were previously passed through verbatim.
 */
export function maskHighEntropyTokens(text: string): string {
  if (!text) return text;

  return text.replace(ENTROPY_CANDIDATE, (token) =>
    looksLikeCredential(token) ? REDACTION_PLACEHOLDER : token,
  );
}

/**
 * Apply the named rules only.
 *
 * The original `maskSecrets`, with the dead-ordering bug fixed and the missing
 * shapes added. Kept as a separate export because the entropy sweep is a
 * heuristic and callers that want only deterministic matches can say so.
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
 *
 * The behaviour the function's name and header comment always claimed. Every
 * input the old implementation redacted is still redacted, in the same place,
 * with the same placeholder.
 */
export function maskSecrets(text: string): string {
  if (!text) return text;
  return maskHighEntropyTokens(maskKnownSecretFormats(text));
}

/**
 * The full pass for anything a finding carries out of the scanner.
 *
 * Currently identical to {@link maskSecrets}; it exists as a distinct name
 * because it marks the *boundary* rather than the algorithm. Everything a
 * finding carries to GitHub or to Postgres goes through this one function, so
 * adding a field to a finding is a one-line change here rather than a hunt for
 * every `.replace()` call site — which is how `explanation` and `remediation`
 * came to exist with no redaction on them at all.
 *
 * Deliberately *not* composed with `scrubCredentials` from `@/lib/redaction`.
 * That function is correct for a log line, where the whole `NAME=value` pair
 * can be collapsed to `[REDACTED_SECRET]`, but it destroys a code snippet:
 * `const secret = "…"` becomes `const [REDACTED_SECRET]`, taking the variable
 * name with it. The rules above redact the value and keep the name, which is
 * what a reviewer needs — the name is not the secret.
 *
 * Applied to `description` and `codeSnippet` in the scanner, and to
 * `explanation` and `remediation` in the worker. Those last two are generated
 * after the scanner has finished, are posted to the pull request and written to
 * Postgres, and previously passed through no redaction at all — which matters
 * most for remediation text, whose natural shape is to quote the offending line
 * back at the reader.
 */
export function maskFindingText(text: unknown): string {
  if (typeof text !== 'string') return '';
  return maskSecrets(text);
}
