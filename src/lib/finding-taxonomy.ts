/**
 * The single source of truth for what kind of thing a finding is.
 *
 * `@/lib/severity` exists because four call sites had four incompatible answers
 * to "what is a valid severity". `Finding.type` is in the state severity was in
 * before that module: it is written to the database **verbatim from the model
 * response** —
 *
 *     const findingType = String(f.type || 'Vulnerability');   // scanner.ts
 *
 * — with no enum, no allow-list and no normalization anywhere in the codebase.
 * The prompt asks for `"Secret | Vulnerability | Misconfig"`, but a model under
 * no obligation to produce one of three exact strings routinely answers
 * `"Hardcoded Secret"`, `"hardcoded_secret"`, `"Secrets"`, `"Security
 * Misconfiguration"` or `"Injection"`.
 *
 * The dashboard then counted those with exact, case-sensitive membership of
 * lists that had visibly been grown by hand as people noticed misses:
 *
 *     type: { in: ['Secret', 'Hardcoded Secret', 'Data Leak', 'Contextual Leak'] }
 *     type: { in: ['Vulnerability', 'Logic Flaw'] }
 *     type: { in: ['Misconfig', 'Potential Misconfig'] }
 *
 * A finding typed `"secret"` matched none of them. A SQL-injection finding
 * typed `"Injection"` matched none of them either, and was therefore counted in
 * no tile at all while being rendered in the table directly underneath (#590).
 *
 * Three layers, most specific first, so the answer is predictable:
 *
 *  1. the canonical category names themselves;
 *  2. an explicit alias table of spellings seen in the wild;
 *  3. an ordered keyword scan, so a phrasing nobody has seen yet still lands in
 *     the right bucket instead of vanishing.
 *
 * Anything that survives all three is `OTHER` — a real bucket with its own
 * tile, not a silent drop. Every finding is counted exactly once, so the tiles
 * always sum to the number of rows.
 *
 * Pure and free of server-only imports, like `severity.ts`, so client
 * components can use it too.
 */

import { toStoredSeverity, type Severity, type StoredSeverity } from './severity';

/**
 * The categories the dashboard reports on.
 *
 * `OTHER` is last and is the fallback. Order is not load-bearing the way
 * `SEVERITY_ORDER` is — nothing derives a rank from the index here — but it is
 * the display order of the tiles.
 */
export const FINDING_CATEGORIES = ['SECRET', 'VULNERABILITY', 'MISCONFIG', 'OTHER'] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** The spelling written to `Finding.type` for each category on new scans. */
export const FINDING_CATEGORY_LABEL: Readonly<Record<FindingCategory, string>> = {
  SECRET: 'Secret',
  VULNERABILITY: 'Vulnerability',
  MISCONFIG: 'Misconfig',
  OTHER: 'Other',
};

/** Human-readable tile heading for each category. */
export const FINDING_CATEGORY_TITLE: Readonly<Record<FindingCategory, string>> = {
  SECRET: 'Secrets',
  VULNERABILITY: 'Vulnerabilities',
  MISCONFIG: 'Misconfigs',
  OTHER: 'Other',
};

/**
 * Exact spellings observed in `Finding.type`, mapped to their category.
 *
 * Keys are matched after upper-casing and stripping separators, so only one
 * casing of each needs listing — `hardcoded_secret`, `Hardcoded Secret` and
 * `HARDCODED-SECRET` all reach `HARDCODEDSECRET`.
 *
 * The first four groups are the strings the two dashboard pages used to
 * enumerate by hand; they are kept so historical rows keep counting exactly as
 * they did. The rest are what the model actually produces.
 */
const TYPE_ALIASES: Readonly<Record<string, FindingCategory>> = {
  // ── Secrets ──────────────────────────────────────────────────────────────
  SECRET: 'SECRET',
  SECRETS: 'SECRET',
  HARDCODEDSECRET: 'SECRET',
  HARDCODEDSECRETS: 'SECRET',
  HARDCODEDCREDENTIAL: 'SECRET',
  HARDCODEDCREDENTIALS: 'SECRET',
  HARDCODEDPASSWORD: 'SECRET',
  HARDCODEDAPIKEY: 'SECRET',
  DATALEAK: 'SECRET',
  CONTEXTUALLEAK: 'SECRET',
  CREDENTIALLEAK: 'SECRET',
  SECRETLEAK: 'SECRET',
  SECRETEXPOSURE: 'SECRET',
  CREDENTIAL: 'SECRET',
  CREDENTIALS: 'SECRET',
  APIKEY: 'SECRET',
  APIKEYEXPOSURE: 'SECRET',
  ACCESSTOKEN: 'SECRET',
  PRIVATEKEY: 'SECRET',
  EXPOSEDSECRET: 'SECRET',
  SENSITIVEDATAEXPOSURE: 'SECRET',
  INFORMATIONDISCLOSURE: 'SECRET',

  // ── Vulnerabilities ──────────────────────────────────────────────────────
  VULNERABILITY: 'VULNERABILITY',
  VULNERABILITIES: 'VULNERABILITY',
  VULN: 'VULNERABILITY',
  LOGICFLAW: 'VULNERABILITY',
  LOGICERROR: 'VULNERABILITY',
  INJECTION: 'VULNERABILITY',
  SQLINJECTION: 'VULNERABILITY',
  COMMANDINJECTION: 'VULNERABILITY',
  CODEINJECTION: 'VULNERABILITY',
  XSS: 'VULNERABILITY',
  CROSSSITESCRIPTING: 'VULNERABILITY',
  CSRF: 'VULNERABILITY',
  SSRF: 'VULNERABILITY',
  PATHTRAVERSAL: 'VULNERABILITY',
  DIRECTORYTRAVERSAL: 'VULNERABILITY',
  INSECUREDESERIALIZATION: 'VULNERABILITY',
  BROKENACCESSCONTROL: 'VULNERABILITY',
  BROKENAUTHENTICATION: 'VULNERABILITY',
  RACECONDITION: 'VULNERABILITY',
  BUFFEROVERFLOW: 'VULNERABILITY',
  DENIALOFSERVICE: 'VULNERABILITY',
  DOS: 'VULNERABILITY',

  // ── Misconfigurations ────────────────────────────────────────────────────
  MISCONFIG: 'MISCONFIG',
  MISCONFIGS: 'MISCONFIG',
  MISCONFIGURATION: 'MISCONFIG',
  POTENTIALMISCONFIG: 'MISCONFIG',
  SECURITYMISCONFIGURATION: 'MISCONFIG',
  INSECURECONFIGURATION: 'MISCONFIG',
  INSECURECONFIG: 'MISCONFIG',
  CONFIGURATION: 'MISCONFIG',
  CONFIGURATIONERROR: 'MISCONFIG',
  WEAKCRYPTOGRAPHY: 'MISCONFIG',
  WEAKCRYPTO: 'MISCONFIG',
  INSECURETRANSPORT: 'MISCONFIG',
  MISSINGSECURITYHEADER: 'MISCONFIG',
  MISSINGSECURITYHEADERS: 'MISCONFIG',
  PERMISSIVECORS: 'MISCONFIG',
  OVERLYPERMISSIVEPERMISSIONS: 'MISCONFIG',
};

/**
 * Ordered keyword fallback for a phrasing that is not in the alias table.
 *
 * Order matters and is the reason this is an array rather than an object: a
 * type reading `"Hardcoded credential in an insecure config"` should be a
 * secret, not a misconfiguration, so `SECRET` keywords are tested first.
 *
 * The keywords are deliberately specific. A substring rule that is too loose
 * does real damage — `filterFalsePositives` drops any Prisma-schema finding
 * whose snippet contains `"int"`, which also matches `print`, `point` and
 * `integrity` — so nothing here is shorter than four characters and none of it
 * is a fragment of a common English word.
 */
const TYPE_KEYWORDS: ReadonlyArray<readonly [FindingCategory, readonly string[]]> = [
  [
    'SECRET',
    ['SECRET', 'CREDENTIAL', 'PASSWORD', 'APIKEY', 'TOKEN', 'PRIVATEKEY', 'LEAK', 'DISCLOSURE'],
  ],
  [
    'VULNERABILITY',
    [
      'VULNERAB',
      'INJECT',
      'TRAVERSAL',
      'OVERFLOW',
      'SCRIPTING',
      'DESERIAL',
      'FORGERY',
      'RACECONDITION',
      'PRIVILEGEESCALATION',
      'EXPLOIT',
      'FLAW',
    ],
  ],
  [
    'MISCONFIG',
    ['MISCONFIG', 'CONFIG', 'HEADER', 'PERMISSION', 'CORS', 'CIPHER', 'CRYPTO', 'HARDENING'],
  ],
];

/**
 * Reduce arbitrary input to the form the alias table is keyed on.
 *
 * Same treatment `severity.ts` applies: trim, upper-case, drop separators. Any
 * non-string input becomes the empty string, which callers read as "no type
 * given".
 */
function canonicalizeKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s_\-/.]+/g, '');
}

/** Narrowing predicate for a value that is already a canonical category. */
export function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === 'string' && (FINDING_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Classify `value`, or return `null` when it cannot be interpreted at all.
 *
 * Total: never throws, for any input including `null`, `undefined`, numbers and
 * objects. Use this when "I could not tell" is a meaningful answer; use
 * {@link normalizeFindingType} when you need a category regardless.
 */
export function parseFindingType(value: unknown): FindingCategory | null {
  const key = canonicalizeKey(value);
  if (!key) return null;

  if (isFindingCategory(key)) return key;

  const aliased = TYPE_ALIASES[key];
  if (aliased) return aliased;

  for (const [category, keywords] of TYPE_KEYWORDS) {
    if (keywords.some((keyword) => key.includes(keyword))) return category;
  }

  return null;
}

/**
 * Classify `value`, falling back to `OTHER`.
 *
 * `OTHER` rather than `VULNERABILITY` deliberately. The scanner's old fallback
 * of `'Vulnerability'` for a missing type made an unclassified finding
 * indistinguishable from one the model actually called a vulnerability, which
 * is a quiet way to inflate one tile with rows that belong nowhere. `OTHER` is
 * surfaced in its own tile instead, so the miss is visible and the alias table
 * can be extended from real data.
 */
export function normalizeFindingType(value: unknown): FindingCategory {
  return parseFindingType(value) ?? 'OTHER';
}

/** The label stored in `Finding.type` for whatever `value` classifies as. */
export function normalizeFindingTypeLabel(value: unknown): string {
  return FINDING_CATEGORY_LABEL[normalizeFindingType(value)];
}

/**
 * Every stored spelling that should count toward `category`.
 *
 * Built from the alias table rather than maintained by hand at each call site,
 * which is what let the two dashboard pages drift into carrying *different*
 * lists for the same tile.
 *
 * `OTHER` has no enumerable spellings — it is defined by what nothing else
 * matches — so it returns an empty array and must be counted by subtraction.
 * {@link findingCategoryFilter} handles that.
 */
export function findingTypeSpellings(category: FindingCategory): string[] {
  if (category === 'OTHER') return [];

  const spellings = new Set<string>([FINDING_CATEGORY_LABEL[category]]);

  for (const [key, mapped] of Object.entries(TYPE_ALIASES)) {
    if (mapped === category) spellings.add(key);
  }

  return [...spellings];
}

/**
 * The `FindingType` enum members, as declared in `prisma/schema.prisma`.
 *
 * `Finding.type` was a free-form `String` when this module was written, which is
 * why everything above exists. #633 migrated it to an enum with exactly three
 * members, so a query against the column can only name one of these three — and
 * only in this exact casing.
 */
export const STORED_FINDING_TYPES = ['SECRET', 'VULNERABILITY', 'MISCONFIG'] as const;

export type StoredFindingType = (typeof STORED_FINDING_TYPES)[number];

/**
 * A Prisma filter selecting the rows belonging to `category`.
 *
 * This used to return every *spelling* of the category — `Hardcoded Secret`,
 * `hardcoded_secret`, `Credential Leak` — together with `mode: 'insensitive'`.
 * That was correct against the old `String` column and is invalid against the
 * enum: Prisma rejects an unknown member, and `mode` is not a valid property on
 * an enum filter at all. The helper was unusable in either direction, and
 * `src/app/dashboard/page.tsx` imported it without ever calling it (#686).
 *
 * The alias table above still earns its keep — {@link normalizeFindingTypeEnum}
 * uses it on the write path to decide which member a model response becomes.
 * What changed is that classification happens before the row is stored, so the
 * query side only ever names the three canonical members.
 *
 * `OTHER` is not an enum member and cannot be one, so it selects nothing. It is
 * expressed as `notIn` over all three rather than as an impossible literal, so
 * the filter stays correct if the enum ever grows a fourth member.
 */
export function findingCategoryFilter(category: FindingCategory) {
  if (category === 'OTHER') {
    return { notIn: [...STORED_FINDING_TYPES] };
  }

  return { in: [category satisfies StoredFindingType] };
}

/**
 * A Prisma filter selecting the rows at a severity level.
 *
 * Same story as {@link findingCategoryFilter}: `Finding.severity` is now a
 * `FindingSeverity` enum, so listing every spelling `parseSeverity` understands
 * (`CRIT`, `SEV0`, `P0`, `BLOCKER`, …) alongside `mode: 'insensitive'` produced
 * a filter Prisma refuses outright.
 *
 * The level is mapped through the storage vocabulary, so `NONE` — which is a
 * ranking level and not an enum member — selects `INFO` rather than throwing.
 */
export function severityFilter(level: Severity | StoredSeverity) {
  return { in: [toStoredSeverity(level)] };
}

/**
 * Maps arbitrary finding type strings to the valid Prisma FindingType enum values:
 * 'SECRET' | 'VULNERABILITY' | 'MISCONFIG' (#633).
 */
export function normalizeFindingTypeEnum(value: unknown): 'SECRET' | 'VULNERABILITY' | 'MISCONFIG' {
  const category = normalizeFindingType(value);
  if (category === 'SECRET') return 'SECRET';
  if (category === 'MISCONFIG') return 'MISCONFIG';
  return 'VULNERABILITY';
}

/**
 * Normalizes decision strings to the Prisma PolicyDecision enum values:
 * 'PASS' | 'REVIEW' | 'BLOCK' (#633).
 */
export function normalizePolicyDecisionEnum(decision: unknown): 'PASS' | 'REVIEW' | 'BLOCK' {
  if (typeof decision !== 'string') return 'REVIEW';
  const clean = decision.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (clean === 'PASS' || clean === 'SUCCESS' || clean === 'APPROVED') return 'PASS';
  if (clean === 'BLOCK' || clean === 'BLOCKED' || clean === 'FAIL' || clean === 'FAILURE') return 'BLOCK';
  return 'REVIEW';
}

/**
 * Normalizes status strings to the Prisma PRStatus enum values:
 * 'PASS' | 'REVIEW_REQUIRED' | 'BLOCKED' (#633).
 */
export function normalizePrStatusEnum(status: unknown): 'PASS' | 'REVIEW_REQUIRED' | 'BLOCKED' {
  if (typeof status !== 'string') return 'REVIEW_REQUIRED';
  const clean = status.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (clean === 'PASS' || clean === 'SUCCESS' || clean === 'APPROVED') return 'PASS';
  if (clean === 'BLOCK' || clean === 'BLOCKED' || clean === 'FAIL' || clean === 'FAILURE') return 'BLOCKED';
  return 'REVIEW_REQUIRED';
}

/**
 * Normalizes state strings to the Prisma PRState enum values:
 * 'OPEN' | 'CLOSED' | 'MERGED' (#633).
 */
export function normalizePrStateEnum(state: unknown): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (typeof state !== 'string') return 'OPEN';
  const clean = state.trim().toUpperCase();
  if (clean === 'CLOSED') return 'CLOSED';
  if (clean === 'MERGED') return 'MERGED';
  return 'OPEN';
}

