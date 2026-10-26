import { describe, expect, it } from 'vitest';
import {
  classify,
  decideNext,
  parseRetryAfter,
  type HttpResult,
  type RetrySettings,
} from './retry-policy.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const response = (status: number, retryAfter?: string): HttpResult => ({
  kind: 'response',
  status,
  retryAfter,
  durationMs: 5,
});

describe('classify', () => {
  it.each([200, 201, 204, 299])('%i succeeds', (status) => {
    expect(classify(response(status), NOW).outcome).toBe('succeeded');
  });

  it.each([408, 425, 429, 500, 502, 503, 504, 599])('%i is retryable', (status) => {
    expect(classify(response(status), NOW)).toMatchObject({
      outcome: 'retryable_failure',
      errorCode: `HTTP_${status}`,
    });
  });

  it.each([301, 302, 400, 401, 403, 404, 410, 422, 501, 505])('%i is permanent', (status) => {
    expect(classify(response(status), NOW).outcome).toBe('permanent_failure');
  });

  it('treats timeouts and network errors as retryable, blocked destinations as permanent', () => {
    expect(classify({ kind: 'error', code: 'TIMEOUT', durationMs: 1 }, NOW).outcome).toBe(
      'retryable_failure',
    );
    expect(classify({ kind: 'error', code: 'NETWORK_ERROR', durationMs: 1 }, NOW).outcome).toBe(
      'retryable_failure',
    );
    expect(
      classify({ kind: 'error', code: 'DESTINATION_BLOCKED', durationMs: 1 }, NOW),
    ).toMatchObject({
      outcome: 'permanent_failure',
      errorCode: 'DESTINATION_BLOCKED',
    });
  });

  it('honours Retry-After only for 429 and 503', () => {
    expect(classify(response(429, '30'), NOW).retryAfterMs).toBe(30_000);
    expect(classify(response(503, '5'), NOW).retryAfterMs).toBe(5_000);
    expect(classify(response(500, '30'), NOW).retryAfterMs).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(new Date(NOW + 60_000).toUTCString(), NOW)).toBe(60_000);
    expect(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
  });

  it('ignores garbage', () => {
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter('-5', NOW)).toBeNull();
  });
});

describe('decideNext', () => {
  const settings: RetrySettings = {
    maxAttempts: 5,
    maxEventAgeMs: 24 * 3_600_000,
    baseDelayMs: 1_000,
    maxDelayMs: 600_000,
  };
  const ctx = (attempt: number, ageMs = 0) => ({
    attempt,
    now: NOW,
    eventCreatedAt: new Date(NOW - ageMs),
  });
  const retryable = classify(response(500), NOW);

  it('schedules a retry within the full-jitter window', () => {
    const next = decideNext(retryable, ctx(3), settings, () => 0.999);
    expect(next.status).toBe('retry_scheduled');
    if (next.status === 'retry_scheduled') {
      const delay = next.nextAttemptAt.getTime() - NOW;
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(4_000); // base * 2^(3-1)
    }
  });

  it('caps Retry-After at the maximum delay', () => {
    const next = decideNext(classify(response(429, '999999'), NOW), ctx(1), settings, () => 0);
    expect(next).toEqual({ status: 'retry_scheduled', nextAttemptAt: new Date(NOW + 600_000) });
  });

  it('dead-letters when attempts are exhausted', () => {
    expect(decideNext(retryable, ctx(5), settings)).toEqual({
      status: 'dead_lettered',
      reason: 'MAX_ATTEMPTS',
    });
  });

  it('dead-letters when the next attempt would exceed the event age limit', () => {
    const old = 24 * 3_600_000 - 500;
    expect(decideNext(retryable, ctx(2, old), settings, () => 0.99)).toEqual({
      status: 'dead_lettered',
      reason: 'EVENT_EXPIRED',
    });
  });

  it('dead-letters permanent failures immediately', () => {
    expect(decideNext(classify(response(404), NOW), ctx(1), settings)).toEqual({
      status: 'dead_lettered',
      reason: 'PERMANENT_FAILURE',
    });
    expect(
      decideNext(
        classify({ kind: 'error', code: 'DESTINATION_BLOCKED', durationMs: 0 }, NOW),
        ctx(1),
        settings,
      ),
    ).toEqual({
      status: 'dead_lettered',
      reason: 'ENDPOINT_POLICY_BLOCKED',
    });
  });
});
