import { createHash } from 'crypto';

/**
 * Interface representing a dynamic security payload signature.
 * Used to detect zero-day payload structures, obfuscated injections,
 * secret leaks, and anomalous patterns.
 */
export interface PayloadSignature {
  id: string;
  name: string;
  pattern: RegExp | string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'ZERO_DAY_EXPLOIT' | 'SECRET_LEAK' | 'INJECTION' | 'RCE' | 'ANOMALOUS_PAYLOAD';
  version: string;
  description?: string;
  updatedAt?: string;
}

export interface DynamicFingerprintResult {
  fingerprint: string;
  signatureVersion: string;
  matchedSignatures: PayloadSignature[];
  riskScore: number;
  isZeroDayDetected: boolean;
}

/**
 * Built-in dynamic zero-day signature database defaults.
 */
const DEFAULT_PAYLOAD_SIGNATURES: PayloadSignature[] = [
  {
    id: 'SIG-ZDAY-001',
    name: 'Obfuscated Dynamic Code Execution (eval/Function)',
    pattern: /(?:eval|Function)\s*\(\s*(?:String\.fromCharCode|atob|decodeURIComponent|unescape|btoa)/i,
    severity: 'CRITICAL',
    category: 'RCE',
    version: '1.0.0',
    description: 'Detects dynamic code execution wrapped in decoding primitives (eval/Function + charCode/atob).'
  },
  {
    id: 'SIG-ZDAY-002',
    name: 'Prototype Pollution Injection Payload',
    pattern: /__proto__\s*\[\s*['"]?[\w-]+['"]?\s*\]\s*=\s*|Object\.prototype\s*\[\s*['"]?[\w-]+['"]?\s*\]/i,
    severity: 'HIGH',
    category: 'ZERO_DAY_EXPLOIT',
    version: '1.0.0',
    description: 'Detects prototype pollution vector assignments.'
  },
  {
    id: 'SIG-ZDAY-003',
    name: 'Polyglot SQL/Command Injection Vector',
    pattern: /(?:UNION\s+SELECT|SLEEP\s*\(\d+\)|BENCHMARK\s*\(|cmd\.exe|\/bin\/sh|\/bin\/bash)\s*/i,
    severity: 'CRITICAL',
    category: 'INJECTION',
    version: '1.0.0',
    description: 'Detects command or SQL polyglot injection attempts.'
  },
  {
    id: 'SIG-ZDAY-004',
    name: 'High-Entropy Zero-Day Secret Pattern',
    pattern: /(?:eyJhbGciOi|sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36}|xox[baprs]-[a-zA-Z0-9]{10,})/i,
    severity: 'CRITICAL',
    category: 'SECRET_LEAK',
    version: '1.0.0',
    description: 'Detects high-entropy hardcoded API tokens or secret formats.'
  }
];

/** Severity → risk score contribution for a single matched signature. */
const SEVERITY_RISK_WEIGHTS: Record<PayloadSignature['severity'], number> = {
  CRITICAL: 40,
  HIGH: 25,
  MEDIUM: 15,
  LOW: 5
};

const VALID_SEVERITIES = new Set(Object.keys(SEVERITY_RISK_WEIGHTS));
const VALID_CATEGORIES = new Set<PayloadSignature['category']>([
  'ZERO_DAY_EXPLOIT',
  'SECRET_LEAK',
  'INJECTION',
  'RCE',
  'ANOMALOUS_PAYLOAD'
]);

/**
 * Regex flags that are safe to keep on a signature pattern.
 *
 * `g` and `y` are deliberately excluded: both make `RegExp.prototype.test`
 * stateful via `lastIndex`, so the same signature tested against the same
 * payload twice returns true, then false, then true. Since the engine is a
 * long-lived singleton reused across every snippet in a scan, that turns into
 * roughly half the matches for that signature being silently dropped.
 */
const SAFE_REGEX_FLAGS = ['i', 'm', 's', 'u', 'v'] as const;

/**
 * Raised when a signature batch cannot be applied. Carries every problem found
 * rather than only the first, so an operator pushing a bad update sees the
 * whole list in one go.
 */
export class SignatureValidationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid signature batch:\n  - ${issues.join('\n  - ')}`);
    this.name = 'SignatureValidationError';
    this.issues = issues;
    Object.setPrototypeOf(this, SignatureValidationError.prototype);
  }
}

/** Internal storage shape: the public signature plus its stateless compiled pattern. */
type CompiledSignature = PayloadSignature & { readonly compiled: RegExp };

/** Strip the internal `compiled` field so callers only ever see the public shape. */
function toPublicSignature(signature: CompiledSignature): PayloadSignature {
  const { compiled: _compiled, ...publicSignature } = signature;
  void _compiled;
  return publicSignature;
}

/**
 * Compile a signature pattern into a stateless RegExp.
 *
 * String patterns are compiled once here rather than on every snippet, and any
 * caller-supplied `g`/`y` flag is stripped so `test()` can never carry
 * `lastIndex` between payloads.
 */
export function compileSignaturePattern(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') {
    return new RegExp(pattern, 'i');
  }

  const flags = SAFE_REGEX_FLAGS.filter(flag => pattern.flags.includes(flag)).join('');
  // `u` and `v` are mutually exclusive; prefer `v` when a caller supplied both.
  const deduped = flags.includes('v') ? flags.replace('u', '') : flags;

  return new RegExp(pattern.source, deduped.includes('i') ? deduped : `${deduped}i`);
}

/**
 * Collect every problem with a candidate signature. An empty array means valid.
 */
export function validateSignature(signature: PayloadSignature, label: string): string[] {
  const issues: string[] = [];

  if (!signature || typeof signature !== 'object') {
    return [`${label}: signature must be an object`];
  }

  if (!signature.id || typeof signature.id !== 'string' || !signature.id.trim()) {
    issues.push(`${label}: missing a non-empty string id`);
  }

  if (signature.pattern === undefined || signature.pattern === null || signature.pattern === '') {
    issues.push(`${label}: missing a pattern`);
  } else if (typeof signature.pattern !== 'string' && !(signature.pattern instanceof RegExp)) {
    issues.push(`${label}: pattern must be a string or RegExp`);
  } else {
    try {
      compileSignaturePattern(signature.pattern);
    } catch (err) {
      issues.push(
        `${label}: pattern is not a valid regular expression (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  if (signature.severity && !VALID_SEVERITIES.has(signature.severity)) {
    issues.push(`${label}: unknown severity "${signature.severity}"`);
  }

  if (signature.category && !VALID_CATEGORIES.has(signature.category)) {
    issues.push(`${label}: unknown category "${signature.category}"`);
  }

  return issues;
}

/**
 * Dynamic Signature Registry for managing, updating, and rotating security payload signatures.
 */
export class DynamicFingerprintEngine {
  private signatures: Map<string, CompiledSignature> = new Map();
  private activeVersion: string = '1.0.0';

  constructor() {
    this.resetToDefaults();
  }

  /**
   * Validate and compile a batch, or throw with every problem listed.
   *
   * Nothing here touches engine state — callers build the finished entries
   * first and only mutate `this.signatures` once the whole batch is known good.
   */
  private prepareBatch(signatures: PayloadSignature[]): CompiledSignature[] {
    if (!Array.isArray(signatures)) {
      throw new SignatureValidationError(['expected an array of signatures']);
    }

    const issues: string[] = [];
    const prepared: CompiledSignature[] = [];
    const seenIds = new Set<string>();

    signatures.forEach((signature, index) => {
      const label = `signature[${index}]${signature?.id ? ` (${signature.id})` : ''}`;
      const problems = validateSignature(signature, label);

      if (problems.length > 0) {
        issues.push(...problems);
        return;
      }

      if (seenIds.has(signature.id)) {
        issues.push(`${label}: duplicate id within the same batch`);
        return;
      }
      seenIds.add(signature.id);

      prepared.push({
        ...signature,
        compiled: compileSignaturePattern(signature.pattern),
        updatedAt: signature.updatedAt || new Date().toISOString()
      });
    });

    if (issues.length > 0) {
      throw new SignatureValidationError(issues);
    }

    return prepared;
  }

  /**
   * Reset signature database back to default initial state.
   */
  public resetToDefaults(): void {
    const prepared = this.prepareBatch(DEFAULT_PAYLOAD_SIGNATURES);
    this.signatures = new Map(prepared.map(sig => [sig.id, sig]));
    this.activeVersion = '1.0.0';
  }

  /**
   * Register a new signature into the active database.
   */
  public registerSignature(signature: PayloadSignature): void {
    const [prepared] = this.prepareBatch([signature]);
    this.signatures.set(prepared.id, prepared);
  }

  /**
   * Dynamically update existing signatures or add new ones without clearing database.
   *
   * The whole batch is validated before anything is written, so a malformed
   * entry halfway through leaves the database exactly as it was.
   */
  public updateSignatureDatabase(signatures: PayloadSignature[], version?: string): void {
    const prepared = this.prepareBatch(signatures);

    for (const sig of prepared) {
      this.signatures.set(sig.id, sig);
    }

    if (version) {
      this.activeVersion = version;
    }
  }

  /**
   * Atomically rotate signature database to a fresh set of signatures.
   *
   * "Atomically" is now literal: the replacement map is built and validated off
   * to the side and only swapped in once every entry is known good. Previously
   * this cleared the live map first and registered entries one at a time, so a
   * single malformed signature left the engine with a partial — or completely
   * empty — database. Because the engine is a shared singleton, that meant
   * every subsequent scan reported zero matches while still looking successful.
   */
  public rotateSignatures(newSignatures: PayloadSignature[], newVersion?: string): void {
    const prepared = this.prepareBatch(newSignatures);

    if (prepared.length === 0) {
      throw new SignatureValidationError([
        'refusing to rotate to an empty signature database — this would disable detection entirely'
      ]);
    }

    // Swap only after the batch is fully built.
    this.signatures = new Map(prepared.map(sig => [sig.id, sig]));

    if (newVersion) {
      this.activeVersion = newVersion;
    } else {
      const parsed = parseInt(this.activeVersion.split('.')[0] || '1', 10);
      const major = Number.isNaN(parsed) ? 1 : parsed;
      this.activeVersion = `${major + 1}.0.0`;
    }
  }

  /**
   * Retrieve active signature database version.
   */
  public getActiveVersion(): string {
    return this.activeVersion;
  }

  /**
   * Retrieve all currently active signatures.
   */
  public getSignatures(): PayloadSignature[] {
    return Array.from(this.signatures.values(), toPublicSignature);
  }

  /**
   * Evaluate a code snippet against active signatures and generate dynamic fingerprint result.
   */
  public analyzePayload(
    repositoryId: string,
    fileLocation: string,
    type: string,
    codeSnippet: string | null | undefined
  ): DynamicFingerprintResult {
    const rawSnippet = codeSnippet ?? '';
    const matchedSignatures: PayloadSignature[] = [];
    let riskScore = 0;

    for (const sig of this.signatures.values()) {
      // `compiled` is stateless by construction, so repeated tests against the
      // same payload are consistent and no per-snippet recompilation is needed.
      if (sig.compiled.test(rawSnippet)) {
        matchedSignatures.push(toPublicSignature(sig));
        riskScore += SEVERITY_RISK_WEIGHTS[sig.severity] ?? SEVERITY_RISK_WEIGHTS.LOW;
      }
    }

    const isZeroDayDetected = matchedSignatures.some(
      s => s.category === 'ZERO_DAY_EXPLOIT' || s.category === 'RCE'
    );

    const baseHash = computeFingerprint(repositoryId, fileLocation, type, rawSnippet);
    const matchedIds = matchedSignatures.map(s => s.id).sort().join(',');

    const compositeInput = `${baseHash}:${this.activeVersion}:${matchedIds}`;
    const dynamicFingerprint = createHash('sha256').update(compositeInput).digest('hex');

    return {
      fingerprint: dynamicFingerprint,
      signatureVersion: this.activeVersion,
      matchedSignatures,
      riskScore: Math.min(riskScore, 100),
      isZeroDayDetected
    };
  }
}

/**
 * Global singleton instance of DynamicFingerprintEngine.
 */
export const dynamicFingerprintEngine = new DynamicFingerprintEngine();

/**
 * Compute a stable fingerprint for a finding.
 *
 * Findings are regenerated on every scan — the latest-wins re-scan behaviour
 * (#255 / PR #269) deletes and recreates the `Finding` rows on each PR
 * `synchronize`, so `Finding.id` changes even when the same issue is detected
 * again. To make triage decisions (dismiss / resolve / false-positive) survive
 * that regeneration we key them off this content hash instead of the row id.
 *
 * The inputs are the parts of a finding that identify *what* was flagged rather
 * than *when*: the repository, the file it lives in, the finding type, and the
 * offending code snippet. Line numbers are intentionally excluded so a finding
 * that merely shifts up or down the file keeps the same fingerprint.
 */
export function computeFingerprint(
  repositoryId: string,
  fileLocation: string,
  type: string,
  codeSnippet: string | null | undefined
): string {
  return createHash('sha256')
    .update(`${repositoryId}\0${fileLocation}\0${type}\0${codeSnippet ?? ''}`)
    .digest('hex');
}

/**
 * Compute dynamic security payload fingerprint with zero-day signature evaluation.
 */
export function computeDynamicFingerprint(
  repositoryId: string,
  fileLocation: string,
  type: string,
  codeSnippet: string | null | undefined
): DynamicFingerprintResult {
  return dynamicFingerprintEngine.analyzePayload(repositoryId, fileLocation, type, codeSnippet);
}

export {
  EXPANDED_SIGNATURE_REGISTRY,
  ensureExpandedSignaturesLoaded,
  isExpandedRegistryLoaded,
  __resetExpandedRegistryForTests,
  getSignaturesByLanguage,
  getSignaturesByFramework,
  getSignaturesByCategory,
  getSignaturesBySeverity,
  searchSignatures,
  loadRegistryIntoEngine,
  exportSignatureCatalogSummary,
  type ExtendedPayloadSignature,
  type LoadRegistryOptions,
  type SignatureCatalogSummary,
  type SignatureLoadReport
} from './signature-registry';
