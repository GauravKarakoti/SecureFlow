import { describe, it, expect } from 'vitest';

console.log('describe type:', typeof describe);

describe('truly minimal', () => {
  it('1+1=2', () => {
    expect(1 + 1).toBe(2);
  });
});
