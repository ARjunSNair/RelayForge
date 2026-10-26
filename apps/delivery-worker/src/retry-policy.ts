import type { AttemptOutcome, DeadLetterReason } from '@relayforge/contracts';
import { fullJitterBackoff } from '@relayforge/messaging';

/** What happened on the wire for a single attempt. */
export type HttpResult =
  | { kind: 'response'; status: number; retryAfter?: string | undefined; durationMs: number }
  | {
      kind: 'error';
      code: 'TIMEOUT' | 'NETWORK_ERROR' | 'DESTINATION_BLOCKED';
      durationMs: number;
    };

export interface Classification {
  outcome: AttemptOutcome;
  errorCode: string | null;
  /** Server-requested delay (429/503 Retry-After), unbounded here. */
  retryAfterMs: number | null;
}

/** 501 Not Implemented and 505 HTTP Version Not Supported will not fix themselves. */
const PERMANENT_5XX = new Set([501, 505]);
const RETRYABLE_4XX = new Set([408, 425, 429]);

export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Only the RFC 9110 IMF-fixdate form; Date.parse alone accepts far too much (e.g. "-5").
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed))
    return null;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Design §7.2: 2xx succeed; 408/425/429 and most 5xx retry; other statuses are permanent. */
export function classify(result: HttpResult, now: number): Classification {
  if (result.kind === 'error') {
    return {
      outcome: result.code === 'DESTINATION_BLOCKED' ? 'permanent_failure' : 'retryable_failure',
      errorCode: result.code,
      retryAfterMs: null,
    };
  }
  const { status } = result;
  if (status >= 200 && status < 300)
    return { outcome: 'succeeded', errorCode: null, retryAfterMs: null };
  const retryable =
    RETRYABLE_4XX.has(status) || (status >= 500 && status < 600 && !PERMANENT_5XX.has(status));
  return {
    outcome: retryable ? 'retryable_failure' : 'permanent_failure',
    errorCode: `HTTP_${status}`,
    retryAfterMs: status === 429 || status === 503 ? parseRetryAfter(result.retryAfter, now) : null,
  };
}

export interface RetrySettings {
  maxAttempts: number;
  maxEventAgeMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type NextState =
  | { status: 'succeeded' }
  | { status: 'retry_scheduled'; nextAttemptAt: Date }
  | { status: 'dead_lettered'; reason: DeadLetterReason };

/** Decide the delivery's next state after an attempt. Never retries forever. */
export function decideNext(
  c: Classification,
  ctx: { attempt: number; eventCreatedAt: Date; now: number },
  settings: RetrySettings,
  random: () => number = Math.random,
): NextState {
  if (c.outcome === 'succeeded') return { status: 'succeeded' };
  if (c.outcome === 'permanent_failure') {
    return {
      status: 'dead_lettered',
      reason:
        c.errorCode === 'DESTINATION_BLOCKED' ? 'ENDPOINT_POLICY_BLOCKED' : 'PERMANENT_FAILURE',
    };
  }
  if (ctx.attempt >= settings.maxAttempts)
    return { status: 'dead_lettered', reason: 'MAX_ATTEMPTS' };

  const backoff = fullJitterBackoff(ctx.attempt, settings.baseDelayMs, settings.maxDelayMs, random);
  const delay = Math.min(settings.maxDelayMs, Math.max(backoff, c.retryAfterMs ?? 0));
  const nextAttemptAt = ctx.now + delay;
  if (nextAttemptAt > ctx.eventCreatedAt.getTime() + settings.maxEventAgeMs) {
    return { status: 'dead_lettered', reason: 'EVENT_EXPIRED' };
  }
  return { status: 'retry_scheduled', nextAttemptAt: new Date(nextAttemptAt) };
}
