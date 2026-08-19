import { describe, it, expect } from 'vitest';
import { SEVERITY_THEME, getSeverityTheme } from './severity-theme';

describe('getSeverityTheme', () => {
  it('maps each canonical severity to its heist label', () => {
    expect(getSeverityTheme('CRITICAL').label).toBe('Interpol Breach');
    expect(getSeverityTheme('HIGH').label).toBe('Hostage Crisis');
    expect(getSeverityTheme('MEDIUM').label).toBe('Camera Glitch');
    expect(getSeverityTheme('LOW').label).toBe('Loose Screws');
    expect(getSeverityTheme('NONE').label).toBe('All Clear');
  });

  it('themes a non-canonical casing instead of dropping to the grey fallback', () => {
    // Previously `SEVERITY_THEME['critical' as Severity]` was undefined, so the
    // dashboard rendered a grey badge reading "critical" rather than the themed
    // red "Interpol Breach".
    expect(getSeverityTheme('critical')).toEqual(SEVERITY_THEME.CRITICAL);
    expect(getSeverityTheme(' High ')).toEqual(SEVERITY_THEME.HIGH);
  });

  it('themes an aliased severity', () => {
    expect(getSeverityTheme('warning')).toEqual(SEVERITY_THEME.MEDIUM);
    expect(getSeverityTheme('p1')).toEqual(SEVERITY_THEME.CRITICAL);
  });

  it('echoes a genuinely unknown string on the neutral badge', () => {
    const theme = getSeverityTheme('SPICY');
    expect(theme.label).toBe('SPICY');
    expect(theme.badgeClass).toBe('bg-slate-500');
  });

  it('never renders [object Object] for a non-string value', () => {
    const theme = getSeverityTheme({ severity: 'HIGH' });
    expect(theme.label).not.toContain('object Object');
    expect(theme.badgeClass).toBe('bg-slate-500');
  });

  it('does not throw on null or undefined', () => {
    expect(() => getSeverityTheme(null)).not.toThrow();
    expect(() => getSeverityTheme(undefined)).not.toThrow();
  });

  it('returns a badge class for every input', () => {
    for (const value of ['CRITICAL', 'nonsense', null, undefined, 42]) {
      expect(getSeverityTheme(value).badgeClass).toBeTruthy();
    }
  });
});
