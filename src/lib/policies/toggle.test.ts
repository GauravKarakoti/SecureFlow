import { describe, it, expect } from 'vitest';
import {
  TOGGLE_ERRORS,
  normalizeToggleInput,
  parseToggleInput,
  togglePolicySchema,
} from './toggle';

describe('parseToggleInput (#660)', () => {
  it('accepts a well-formed request', () => {
    expect(parseToggleInput({ templateId: 'tpl-1', isActive: true })).toEqual({
      templateId: 'tpl-1',
      isActive: true,
    });
  });

  it('accepts disabling a rule', () => {
    expect(parseToggleInput({ templateId: 'tpl-1', isActive: false })?.isActive).toBe(false);
  });

  it('trims the template id', () => {
    expect(parseToggleInput({ templateId: '  tpl-1  ', isActive: true })?.templateId).toBe('tpl-1');
  });

  it('rejects a missing template id', () => {
    // `formData.get(...) as string` asserted this away, so it reached Prisma as
    // policyTemplateId: null and threw a foreign-key violation out of a server
    // action.
    expect(parseToggleInput({ isActive: true })).toBeNull();
    expect(parseToggleInput({ templateId: null, isActive: true })).toBeNull();
    expect(parseToggleInput({ templateId: '', isActive: true })).toBeNull();
    expect(parseToggleInput({ templateId: '   ', isActive: true })).toBeNull();
  });

  it('rejects a non-string template id', () => {
    expect(parseToggleInput({ templateId: 42, isActive: true })).toBeNull();
    expect(parseToggleInput({ templateId: {}, isActive: true })).toBeNull();
  });

  it('rejects an absurdly long template id', () => {
    expect(parseToggleInput({ templateId: 'a'.repeat(65), isActive: true })).toBeNull();
  });

  it('rejects a missing or non-boolean desired state', () => {
    expect(parseToggleInput({ templateId: 'tpl-1' })).toBeNull();
    expect(parseToggleInput({ templateId: 'tpl-1', isActive: 'true' })).toBeNull();
    expect(parseToggleInput({ templateId: 'tpl-1', isActive: 1 })).toBeNull();
  });

  it('rejects a payload that is not an object at all', () => {
    expect(parseToggleInput(null)).toBeNull();
    expect(parseToggleInput(undefined)).toBeNull();
    expect(parseToggleInput('tpl-1')).toBeNull();
    expect(parseToggleInput([])).toBeNull();
  });

  it('is idempotent — the same request parses to the same value every time', () => {
    const request = { templateId: 'tpl-1', isActive: false };

    expect(parseToggleInput(request)).toEqual(parseToggleInput(request));
  });
});

describe('normalizeToggleInput (#660)', () => {
  it('passes a typed object straight through', () => {
    expect(normalizeToggleInput({ templateId: 'tpl-1', isActive: true })).toEqual({
      templateId: 'tpl-1',
      isActive: true,
    });
  });

  it('accepts a FormData carrying the desired state', () => {
    const form = new FormData();
    form.append('templateId', 'tpl-1');
    form.append('isActive', 'true');

    expect(normalizeToggleInput(form)).toEqual({ templateId: 'tpl-1', isActive: true });
  });

  it('reads isActive=false from FormData as false, not as a truthy string', () => {
    const form = new FormData();
    form.append('templateId', 'tpl-1');
    form.append('isActive', 'false');

    expect(normalizeToggleInput(form)?.isActive).toBe(false);
  });

  it('rejects the old currentState-only payload rather than inverting it', () => {
    // Inverting a value the client may have read minutes ago is precisely the
    // bug this change removes, so a payload that only carries the previous
    // state is refused instead of guessed at.
    const form = new FormData();
    form.append('templateId', 'tpl-1');
    form.append('currentState', 'false');

    expect(normalizeToggleInput(form)).toBeNull();
  });

  it('rejects FormData with a missing template id', () => {
    const form = new FormData();
    form.append('isActive', 'true');

    expect(normalizeToggleInput(form)).toBeNull();
  });

  it('rejects a File where a string was expected', () => {
    const form = new FormData();
    form.append('templateId', new File(['x'], 'x.txt'));
    form.append('isActive', 'true');

    expect(normalizeToggleInput(form)).toBeNull();
  });
});

describe('togglePolicySchema (#660)', () => {
  it('exposes the same rules parseToggleInput applies', () => {
    expect(togglePolicySchema.safeParse({ templateId: 'tpl-1', isActive: true }).success).toBe(true);
    expect(togglePolicySchema.safeParse({ templateId: '', isActive: true }).success).toBe(false);
  });
});

describe('TOGGLE_ERRORS (#660)', () => {
  it('distinguishes the failure modes the UI needs to tell apart', () => {
    const messages = Object.values(TOGGLE_ERRORS);

    expect(new Set(messages).size).toBe(messages.length);
    // An expired session is the ordinary way to arrive here, having left the
    // tab open, and used to be indistinguishable from success.
    expect(TOGGLE_ERRORS.unauthenticated).toMatch(/sign in/i);
  });
});
