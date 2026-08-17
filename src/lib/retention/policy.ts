/**
 * Declarative data-retention policy.
 *
 * Every table SecureFlow writes currently grows forever. `AuditLog`,
 * `WebhookEvent`, `ScanResult` and `Finding` have no purge path in normal
 * operation: cascades only fire when a `Repository` or `User` is deleted, which
 * does not happen on a live install.
 *
 * `Finding.codeSnippet` is the one that matters most. It stores a verbatim
 * excerpt of the customer's source, taken from a pull request diff, retained
 * indefinitely. `maskSecrets()` scrubs the secret formats it recognises, but it
 * is a regex allowlist — anything without a pattern is stored in plaintext. A
 * scanner that keeps an unbounded permanent archive of other people's private
 * code is a liability, not a feature.
 *
 * The windows here are read from the environment and validated on load, so a
 * typo'd variable fails loudly at startup instead of silently defaulting to
 * "keep forever".
 */

/** A retention rule for one model. */
export interface RetentionRule {
  /** Model key, matching the `PurgeTarget` union below. */
  target: PurgeTarget;
  /** Environment variable that overrides `defaultDays`. */
  envVar: string;
  /** Days to retain when the variable is unset. */
  defaultDays: number;
  /** Human-readable justification, surfaced by `--dry-run` and in the docs. */
  rationale: string;
}

export type PurgeTarget = 'auditLog' | 'webhookEvent' | 'scanResult' | 'findingSnippet';

/**
 * The policy.
 *
 * Findings are treated differently from everything else: the *snippet* expires
 * long before the finding does. That decouples "how long we keep the evidence"
 * from "how long we keep your code" — the security history (type, severity,
 * file, fingerprint) survives redaction, so trend data and triage decisions are
 * not destroyed by honouring a short code-retention window.
 */
export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    target: 'findingSnippet',
    envVar: 'FINDING_SNIPPET_REDACT_DAYS',
    defaultDays: 90,
    rationale:
      'Redacts the copied source excerpt while keeping the finding row, so security history survives without an indefinite archive of customer code.',
  },
  {
    target: 'webhookEvent',
    envVar: 'WEBHOOK_EVENT_RETENTION_DAYS',
    defaultDays: 30,
    rationale:
      'Delivery-id rows exist for idempotency. GitHub does not redeliver beyond a few days, so a month is generous.',
  },
  {
    target: 'scanResult',
    envVar: 'SCAN_RESULT_RETENTION_DAYS',
    defaultDays: 180,
    rationale:
      'Scan history feeds the risk trend and the leaderboard. Six months keeps those meaningful without unbounded growth. Cascades remove the attached findings.',
  },
  {
    target: 'auditLog',
    envVar: 'AUDIT_LOG_RETENTION_DAYS',
    defaultDays: 365,
    rationale:
      'Audit rows carry userId and metadata — personal data under GDPR Art. 5(1)(e), which expects a stated, bounded retention period.',
  },
] as const;

/** Upper bound on any configured window: 10 years. Beyond this it is a typo. */
export const MAX_RETENTION_DAYS = 3650;

/** Lower bound. A window of 0 would purge rows the moment they are written. */
export const MIN_RETENTION_DAYS = 1;

/** Thrown when a retention variable is present but unusable. */
export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionConfigError';
  }
}

/**
 * Parse one window.
 *
 * An unset variable takes the default. A *set but invalid* variable throws
 * rather than falling back: someone tried to configure this and got it wrong,
 * and silently retaining data for the default period instead of the intended
 * one is exactly the failure this module exists to prevent.
 */
export function parseRetentionDays(rule: RetentionRule, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return rule.defaultDays;

  const parsed = Number(raw.trim());

  if (!Number.isInteger(parsed)) {
    throw new RetentionConfigError(
      `${rule.envVar} must be a whole number of days, got "${raw}".`
    );
  }

  if (parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) {
    throw new RetentionConfigError(
      `${rule.envVar} must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days, got ${parsed}.`
    );
  }

  return parsed;
}

export interface ResolvedRetention extends RetentionRule {
  days: number;
  /** Rows older than this are in scope. */
  cutoff: Date;
}

/**
 * Resolve the whole policy against an environment.
 *
 * `now` is injected so the cutoffs are deterministic in tests, and so every rule
 * in one run shares a single reference time — otherwise a slow run could compute
 * cutoffs milliseconds apart and produce results that are awkward to reason
 * about after the fact.
 */
export function resolveRetentionPolicy(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date()
): ResolvedRetention[] {
  return RETENTION_RULES.map((rule) => {
    const days = parseRetentionDays(rule, env[rule.envVar]);
    return {
      ...rule,
      days,
      cutoff: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    };
  });
}

/** Look up one resolved rule by target. Throws for an unknown target. */
export function retentionFor(
  target: PurgeTarget,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date()
): ResolvedRetention {
  const found = resolveRetentionPolicy(env, now).find((rule) => rule.target === target);
  if (!found) throw new RetentionConfigError(`Unknown retention target "${target}".`);
  return found;
}
