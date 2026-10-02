import { describe, it, expect } from 'vitest';
import { getMasterFuzzingCorpus } from './prompt-injection-payloads';

describe('Automated Red-Team Fuzzing Suite (#1184)', () => {
  it('should successfully load and validate all red-team fuzzing payloads', () => {
    const payloads = getMasterFuzzingCorpus();
    expect(payloads.length).toBeGreaterThan(0);
    
    for (const testCase of payloads) {
      expect(testCase.id).toBeDefined();
      expect(testCase.category).toBeDefined();
      expect(testCase.payload).toBeDefined();
      expect(testCase.severity).toMatch(/low|medium|high|critical/);
      expect(testCase.expectedBehavior).toMatch(/blocked|flagged|sanitized/);
    }
  });
});
