import { describe, expect, it } from 'vitest';
import { fullJitterBackoff } from './backoff.js';

describe('fullJitterBackoff', () => {
  it('spans [0, base * 2^(attempt-1)) for the random range', () => {
    expect(fullJitterBackoff(1, 1_000, 60_000, () => 0)).toBe(0);
    expect(fullJitterBackoff(1, 1_000, 60_000, () => 0.999999)).toBe(999);
    expect(fullJitterBackoff(4, 1_000, 60_000, () => 0.5)).toBe(4_000);
  });

  it('never exceeds the cap, even for very large attempt numbers', () => {
    for (const attempt of [10, 50, 1_000]) {
      expect(fullJitterBackoff(attempt, 1_000, 60_000, () => 0.999999)).toBeLessThan(60_000);
    }
  });

  it('stays within bounds with real randomness', () => {
    for (let i = 0; i < 1_000; i++) {
      const d = fullJitterBackoff(3, 1_000, 60_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(4_000);
    }
  });
});
