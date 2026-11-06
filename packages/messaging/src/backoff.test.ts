import { afterEach, describe, expect, it, vi } from 'vitest';
import { fullJitterBackoff, sleep } from './backoff.js';

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

describe('sleep', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves once the delay has elapsed', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void sleep(1_000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it('resolves immediately when the signal is already aborted', async () => {
    vi.useFakeTimers();
    await sleep(60_000, AbortSignal.abort());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves early on abort and clears its timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
