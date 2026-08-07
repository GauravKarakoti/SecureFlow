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

/**
 * Dynamic Signature Registry for managing, updating, and rotating security payload signatures.
 */
export class DynamicFingerprintEngine {
  private signatures: Map<string, PayloadSignature> = new Map();
  private activeVersion: string = '1.0.0';

  constructor() {
    this.resetToDefaults();
  }

  /**
   * Reset signature database back to default initial state.
   */
  public resetToDefaults(): void {
    this.signatures.clear();
    this.activeVersion = '1.0.0';
    for (const sig of DEFAULT_PAYLOAD_SIGNATURES) {
      this.signatures.set(sig.id, { ...sig });
    }
  }

  /**
   * Register a new signature into the active database.
   */
  public registerSignature(signature: PayloadSignature): void {
    if (!signature.id || !signature.pattern) {
      throw new Error('Signature must contain a valid id and pattern');
    }
    this.signatures.set(signature.id, {
      ...signature,
      updatedAt: signature.updatedAt || new Date().toISOString()
    });
  }

  /**
   * Dynamically update existing signatures or add new ones without clearing database.
   */
  public updateSignatureDatabase(signatures: PayloadSignature[], version?: string): void {
    for (const sig of signatures) {
      this.registerSignature(sig);
    }
    if (version) {
      this.activeVersion = version;
    }
  }

  /**
   * Atomically rotate signature database to a fresh set of signatures.
   */
  public rotateSignatures(newSignatures: PayloadSignature[], newVersion?: string): void {
    this.signatures.clear();
    for (const sig of newSignatures) {
      this.registerSignature(sig);
    }
    if (newVersion) {
      this.activeVersion = newVersion;
    } else {
      const parsed = parseInt(this.activeVersion.split('.')[0] || '1', 10);
      this.activeVersion = `${parsed + 1}.0.0`;
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
    return Array.from(this.signatures.values());
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
      const regex = typeof sig.pattern === 'string' ? new RegExp(sig.pattern, 'i') : sig.pattern;
      if (regex.test(rawSnippet)) {
        matchedSignatures.push(sig);
        if (sig.severity === 'CRITICAL') riskScore += 40;
        else if (sig.severity === 'HIGH') riskScore += 25;
        else if (sig.severity === 'MEDIUM') riskScore += 15;
        else riskScore += 5;
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
