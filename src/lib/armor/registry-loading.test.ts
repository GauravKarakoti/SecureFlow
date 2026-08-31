import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DynamicFingerprintEngine,
  computeDynamicFingerprint,
  dynamicFingerprintEngine,
} from './fingerprint';
import {
  EXPANDED_SIGNATURE_REGISTRY,
  ensureExpandedSignaturesLoaded,
  isExpandedRegistryLoaded,
  __resetExpandedRegistryForTests,
} from './signature-registry';

/** The four patterns the engine ships with, before anything is merged in. */
const DEFAULT_IDS = ['SIG-ZDAY-001', 'SIG-ZDAY-002', 'SIG-ZDAY-003', 'SIG-ZDAY-004'];

beforeEach(() => {
  __resetExpandedRegistryForTests();
  dynamicFingerprintEngine.resetToDefaults();
});

describe('the shipped registry', () => {
  it('validates, so a malformed entry fails here rather than in production', () => {
    // `prepareBatch` throws `SignatureValidationError` listing every problem,
    // and `ensureExpandedSignaturesLoaded` catches that so a bad addition
    // cannot take down the scan path. This is the assertion that makes the
    // catch safe: a broken registry is a red build, not a silent degradation.
    const engine = new DynamicFingerprintEngine();
    const report = ensureExpandedSignaturesLoaded(engine);

    expect(report.error).toBeUndefined();
    expect(report.loaded).toBe(true);
    expect(report.count).toBe(EXPANDED_SIGNATURE_REGISTRY.length);
  });

  it('covers more than the four JavaScript defaults', () => {
    expect(EXPANDED_SIGNATURE_REGISTRY.length).toBeGreaterThan(20);
  });

  it('has no id colliding with a default', () => {
    const ids = EXPANDED_SIGNATURE_REGISTRY.map((s) => s.id);
    expect(ids.filter((id) => DEFAULT_IDS.includes(id))).toEqual([]);
  });

  it('has no duplicate ids, which prepareBatch rejects as a batch', () => {
    const ids = EXPANDED_SIGNATURE_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ensureExpandedSignaturesLoaded', () => {
  it('merges rather than replacing, so the defaults survive', () => {
    // `rotateSignatures` — the engine's other public path — replaces the map
    // wholesale and would drop all four. The two are one word apart at the
    // call site.
    const engine = new DynamicFingerprintEngine();
    ensureExpandedSignaturesLoaded(engine);

    const ids = engine.getSignatures().map((s) => s.id);

    for (const id of DEFAULT_IDS) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain('SIG-PY-001');
    expect(ids.length).toBe(DEFAULT_IDS.length + EXPANDED_SIGNATURE_REGISTRY.length);
  });

  it('updates the reported version off the base catalogue', () => {
    const engine = new DynamicFingerprintEngine();
    expect(engine.getActiveVersion()).toBe('1.0.0');

    ensureExpandedSignaturesLoaded(engine);

    expect(engine.getActiveVersion()).toBe('1.1.0');
  });

  it('runs once per process', () => {
    const engine = new DynamicFingerprintEngine();

    const first = ensureExpandedSignaturesLoaded(engine);
    const second = ensureExpandedSignaturesLoaded(engine);

    expect(first.loaded).toBe(true);
    expect(second.loaded).toBe(false);
    expect(second.count).toBe(0);
  });

  it('reports whether the attempt has happened', () => {
    expect(isExpandedRegistryLoaded()).toBe(false);
    ensureExpandedSignaturesLoaded(new DynamicFingerprintEngine());
    expect(isExpandedRegistryLoaded()).toBe(true);
  });

  it('honours a language filter', () => {
    const engine = new DynamicFingerprintEngine();
    const report = ensureExpandedSignaturesLoaded(engine, { languages: ['python'] });

    const ids = engine.getSignatures().map((s) => s.id);

    expect(report.count).toBeGreaterThan(0);
    expect(ids).toContain('SIG-PY-001');
    expect(ids).not.toContain('SIG-GO-001');
    // Still merged, so the defaults are still there.
    expect(ids).toContain('SIG-ZDAY-001');
  });

  it('leaves the engine alone and reports the reason when the batch is refused', () => {
    const engine = new DynamicFingerprintEngine();
    const before = engine.getSignatures().map((s) => s.id);

    vi.spyOn(engine, 'updateSignatureDatabase').mockImplementation(() => {
      throw new Error('signature[0] (SIG-X): pattern is not a valid regular expression');
    });

    const report = ensureExpandedSignaturesLoaded(engine);

    expect(report.loaded).toBe(false);
    expect(report.error).toContain('not a valid regular expression');
    expect(engine.getSignatures().map((s) => s.id)).toEqual(before);
  });

  it('does not retry a refused load on every call', () => {
    const engine = new DynamicFingerprintEngine();
    const update = vi.spyOn(engine, 'updateSignatureDatabase').mockImplementation(() => {
      throw new Error('nope');
    });

    ensureExpandedSignaturesLoaded(engine);
    ensureExpandedSignaturesLoaded(engine);
    ensureExpandedSignaturesLoaded(engine);

    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('what the scanner can now detect', () => {
  beforeEach(() => {
    ensureExpandedSignaturesLoaded();
  });

  it('matches a Python pickle deserialisation, which it could not before', () => {
    // Before this change: { matchedSignatures: [], isZeroDayDetected: false,
    //                       signatureVersion: '1.0.0', riskScore: 0 }
    const result = computeDynamicFingerprint(
      'repo-1',
      'app/views.py',
      'Vulnerability',
      'data = pickle.loads(request.body)',
    );

    expect(result.matchedSignatures.map((s) => s.id)).toContain('SIG-PY-001');
    expect(result.isZeroDayDetected).toBe(true);
    expect(result.riskScore).toBeGreaterThan(0);
  });

  it('reports the loaded catalogue version on every finding', () => {
    const result = computeDynamicFingerprint('repo-1', 'a.py', 'Vulnerability', 'x = 1');

    expect(result.signatureVersion).toBe('1.1.0');
  });

  it('still matches the original JavaScript defaults', () => {
    const result = computeDynamicFingerprint(
      'repo-1',
      'src/app.js',
      'Vulnerability',
      'eval(atob(payload))',
    );

    expect(result.matchedSignatures.map((s) => s.id)).toContain('SIG-ZDAY-001');
  });

  it('reports a clean snippet as clean', () => {
    const result = computeDynamicFingerprint(
      'repo-1',
      'src/util.ts',
      'Vulnerability',
      'export const add = (a: number, b: number) => a + b;',
    );

    expect(result.matchedSignatures).toEqual([]);
    expect(result.isZeroDayDetected).toBe(false);
  });

  it('changes the fingerprint when a signature matches, as the composite intends', () => {
    const clean = computeDynamicFingerprint('r', 'a.py', 'Vulnerability', 'x = 1');
    const dirty = computeDynamicFingerprint(
      'r',
      'a.py',
      'Vulnerability',
      'data = pickle.loads(body)',
    );

    expect(clean.fingerprint).not.toBe(dirty.fingerprint);
  });
});
