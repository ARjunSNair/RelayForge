import {
  DELIVERY_REQUESTED,
  DeliveryRequestedV1,
  type DeadLetterReason,
} from '@relayforge/contracts';
import {
  refreshEventStatus,
  withTransaction,
  type Pool,
  type Queryable,
} from '@relayforge/database';
import type { ReceivedMessage } from '@relayforge/messaging';
import {
  formatTraceparent,
  metrics,
  parseTraceparent,
  startSpan,
  type Logger,
  type TraceContext,
} from '@relayforge/observability';
import { checkDestinationUrl, signPayload, type SecretKeyring } from '@relayforge/security';
import type { WebhookHttpClient } from './http-client.js';
import {
  classify,
  decideNext,
  type Classification,
  type NextState,
  type RetrySettings,
} from './retry-policy.js';

/** How the queue message should be settled once handling finishes. */
export type Disposition =
  | { action: 'complete' }
  | { action: 'abandon'; delayMs: number }
  | { action: 'dead_letter'; reason: string };

/** Delivery fairness and endpoint protection (design §9.4, ADR-008). */
export interface FairnessSettings {
  /** In-flight attempts per endpoint when the endpoint sets no max_concurrency. */
  endpointDefaultConcurrency: number;
  tenantMaxConcurrency: number;
  /** Delay before a delivery that hit a concurrency cap is offered again. */
  deferMs: number;
  /** Consecutive retryable failures that open the breaker; 0 disables it. */
  failureThreshold: number;
  suspensionMs: number;
}

export const DEFAULT_FAIRNESS: FairnessSettings = {
  endpointDefaultConcurrency: 4,
  tenantMaxConcurrency: 32,
  deferMs: 2_000,
  failureThreshold: 10,
  suspensionMs: 5 * 60_000,
};

export type DeferReason = 'ENDPOINT_SUSPENDED' | 'ENDPOINT_CONCURRENCY' | 'TENANT_CONCURRENCY';

export interface ProcessorDeps {
  pool: Pool;
  keyring: SecretKeyring;
  http: Pick<WebhookHttpClient, 'post'>;
  logger: Logger;
  retry: RetrySettings;
  /** Lease on an in_progress delivery; must exceed the HTTP timeout. */
  leaseMs: number;
  allowInsecureDestinations: boolean;
  fairness?: FairnessSettings;
  now?: () => number;
  random?: () => number;
}

interface ClaimedDelivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: unknown;
  event_created_at: Date;
  event_traceparent: string | null;
  url: string;
  endpoint_status: 'active' | 'disabled';
  signing_secret_ciphertext: Buffer;
  signing_secret_key_id: string;
  /** Present only while a rotation overlap window is open. */
  previous_signing_secret_ciphertext: Buffer | null;
  previous_signing_secret_key_id: string | null;
}

interface ClaimCandidate {
  endpoint_id: string;
  max_concurrency: number | null;
  consecutive_failures: number;
  suppressed_until: Date | null;
  suppressed: boolean;
}

type Claim =
  | { kind: 'claimed'; delivery: ClaimedDelivery }
  | { kind: 'deferred'; reason: DeferReason; until: Date }
  | { kind: 'busy' | 'stale' | 'missing' };

type Final = NextState | { status: 'cancelled' };

interface AttemptRecord {
  startedAt: Date;
  durationMs: number;
  httpStatus: number | null;
  classification: Classification;
  traceId: string;
}

/** Another execution took over this delivery (lease expired and was recovered). */
class LeaseLostError extends Error {}

const USER_AGENT = 'RelayForge-Webhooks/0.2';

/** Advisory-lock keys; collisions only add serialisation, never incorrectness. */
const TENANT_LOCK = 'relayforge:claim:tenant:';
const ENDPOINT_LOCK = 'relayforge:claim:endpoint:';

/**
 * Handles one `delivery.requested` message (design §8.2):
 * validate → claim (fenced by attempt number, subject to fairness caps) →
 * POST → persist outcome → settle. The message is completed only after the
 * outcome is committed; any failure to persist leaves it to be redelivered.
 */
export class DeliveryProcessor {
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #fairness: FairnessSettings;

  constructor(private readonly deps: ProcessorDeps) {
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#fairness = deps.fairness ?? DEFAULT_FAIRNESS;
  }

  async handle(message: ReceivedMessage): Promise<Disposition> {
    const parsed = DeliveryRequestedV1.safeParse(message.body);
    if (message.subject !== DELIVERY_REQUESTED || !parsed.success) {
      this.deps.logger.warn(
        { message_id: message.messageId, error_code: 'INVALID_MESSAGE' },
        'dead-lettering invalid message',
      );
      return { action: 'dead_letter', reason: 'INVALID_MESSAGE' satisfies DeadLetterReason };
    }
    const msg = parsed.data;
    const parentTrace = parseTraceparent(message.traceparent);
    let log = this.deps.logger.child({
      tenant_id: msg.tenantId,
      event_id: msg.eventId,
      delivery_id: msg.deliveryId,
      attempt: msg.attempt,
      ...(parentTrace ? { trace_id: parentTrace.traceId } : {}),
    });

    const claimed = await this.#claim(msg);
    if (claimed.kind === 'deferred') {
      metrics.deferrals.inc({ reason: claimed.reason });
      log.debug(
        {
          operation: 'delivery.claim',
          outcome: 'deferred',
          reason: claimed.reason,
          until: claimed.until.toISOString(),
        },
        'delivery deferred',
      );
      return { action: 'complete' };
    }
    if (claimed.kind !== 'claimed') {
      log.info({ operation: 'delivery.claim', outcome: claimed.kind }, 'delivery not claimable');
      if (claimed.kind === 'busy') return { action: 'abandon', delayMs: 5_000 };
      if (claimed.kind === 'missing') return { action: 'dead_letter', reason: 'INVALID_MESSAGE' };
      // Stale or duplicate message: a newer attempt owns the delivery, or it is finished.
      return { action: 'complete' };
    }
    const d = claimed.delivery;
    const span = startSpan(parentTrace ?? parseTraceparent(d.event_traceparent));
    if (!parentTrace) log = log.child({ trace_id: span.traceId });

    let final: Final;
    let attempt: AttemptRecord | null = null;
    if (d.endpoint_status !== 'active') {
      final = { status: 'cancelled' };
    } else if (this.#now() > d.event_created_at.getTime() + this.deps.retry.maxEventAgeMs) {
      final = { status: 'dead_lettered', reason: 'EVENT_EXPIRED' };
    } else {
      attempt = await this.#attempt(msg, d, span);
      final = decideNext(
        attempt.classification,
        { attempt: msg.attempt, eventCreatedAt: d.event_created_at, now: this.#now() },
        this.deps.retry,
        this.deps.random,
      );
    }

    let breakerOpened = false;
    try {
      breakerOpened = await this.#persist(msg, d.endpoint_id, final, attempt);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        log.warn(
          { operation: 'delivery.persist', outcome: 'lease_lost' },
          'delivery was taken over; discarding result',
        );
        return { action: 'complete' };
      }
      throw error;
    }

    this.#record(final, attempt, breakerOpened);
    if (breakerOpened) {
      log.warn(
        {
          operation: 'endpoint.suppress',
          endpoint_id: d.endpoint_id,
          suspension_ms: this.#fairness.suspensionMs,
        },
        'endpoint suspended after consecutive failures',
      );
    }
    log.info(
      {
        operation: 'delivery.attempt',
        outcome: final.status,
        http_status: attempt?.httpStatus ?? undefined,
        error_code:
          attempt?.classification.errorCode ?? ('reason' in final ? final.reason : undefined),
        duration_ms: attempt?.durationMs,
      },
      'delivery attempt finished',
    );
    return { action: 'complete' };
  }

  async #claim(msg: DeliveryRequestedV1): Promise<Claim> {
    const result = await withTransaction(this.deps.pool, async (tx): Promise<Claim | null> => {
      const fence = [msg.deliveryId, msg.tenantId, msg.eventId, msg.attempt];
      const { rows } = await tx.query<ClaimCandidate>(
        `SELECT d.endpoint_id, w.max_concurrency, w.consecutive_failures, w.suppressed_until,
                coalesce(w.suppressed_until > now(), false) AS suppressed
           FROM deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id
          WHERE d.id = $1 AND d.tenant_id = $2 AND d.event_id = $3
            AND d.status = 'queued' AND d.attempt_count = $4 - 1`,
        fence,
      );
      const candidate = rows[0];
      if (!candidate) return null;

      const defer = async (reason: DeferReason, until: Date): Promise<Claim> => {
        // Back to the scheduler without using an attempt: it re-sends the same attempt number.
        await tx.query(
          `UPDATE deliveries SET status = 'retry_scheduled', next_attempt_at = $5, updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND event_id = $3
              AND status = 'queued' AND attempt_count = $4 - 1`,
          [...fence, until],
        );
        return { kind: 'deferred', reason, until };
      };
      const jitter = (ms: number) => Math.floor(ms * (1 + this.#random() * 0.5));

      if (candidate.suppressed) {
        return defer(
          'ENDPOINT_SUSPENDED',
          new Date(candidate.suppressed_until!.getTime() + jitter(1_000)),
        );
      }

      // Serialise claims per tenant, then per endpoint (always in that order),
      // so the in-flight counts below cannot be raced by another worker.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [TENANT_LOCK + msg.tenantId]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        ENDPOINT_LOCK + candidate.endpoint_id,
      ]);
      const inflight = await tx.query<{ endpoint: number; tenant: number }>(
        `SELECT count(*) FILTER (WHERE endpoint_id = $2)::int AS endpoint, count(*)::int AS tenant
           FROM deliveries
          WHERE tenant_id = $1 AND status = 'in_progress' AND locked_until > now()`,
        [msg.tenantId, candidate.endpoint_id],
      );
      const { endpoint, tenant } = inflight.rows[0]!;
      const { failureThreshold, endpointDefaultConcurrency, tenantMaxConcurrency, deferMs } =
        this.#fairness;
      // Half-open breaker: after suspension ends, one probe at a time until a success.
      const halfOpen = failureThreshold > 0 && candidate.consecutive_failures >= failureThreshold;
      const endpointCap = halfOpen ? 1 : (candidate.max_concurrency ?? endpointDefaultConcurrency);
      if (endpoint >= endpointCap) {
        return defer('ENDPOINT_CONCURRENCY', new Date(this.#now() + jitter(deferMs)));
      }
      if (tenant >= tenantMaxConcurrency) {
        return defer('TENANT_CONCURRENCY', new Date(this.#now() + jitter(deferMs)));
      }

      const claimed = await tx.query<ClaimedDelivery>(
        `WITH claimed AS (
           UPDATE deliveries d
              SET status = 'in_progress', attempt_count = $4, last_attempt_at = now(),
                  locked_until = now() + make_interval(secs => $5::double precision / 1000), updated_at = now()
            WHERE d.id = $1 AND d.tenant_id = $2 AND d.event_id = $3
              AND d.status = 'queued' AND d.attempt_count = $4 - 1
          RETURNING d.id, d.event_id, d.endpoint_id
         )
         SELECT c.id, c.endpoint_id, e.event_type, e.payload, e.created_at AS event_created_at,
                e.traceparent AS event_traceparent,
                w.url, w.status AS endpoint_status, w.signing_secret_ciphertext, w.signing_secret_key_id,
                CASE WHEN w.previous_secret_expires_at > now()
                     THEN w.previous_signing_secret_ciphertext END AS previous_signing_secret_ciphertext,
                CASE WHEN w.previous_secret_expires_at > now()
                     THEN w.previous_signing_secret_key_id END AS previous_signing_secret_key_id
           FROM claimed c
           JOIN events e ON e.id = c.event_id
           JOIN webhook_endpoints w ON w.id = c.endpoint_id`,
        [...fence, this.deps.leaseMs],
      );
      return claimed.rows[0] ? { kind: 'claimed', delivery: claimed.rows[0] } : null;
    });
    if (result) return result;

    const current = await this.deps.pool.query<{
      status: string;
      attempt_count: number;
      locked: boolean;
    }>(
      `SELECT status, attempt_count, locked_until > now() AS locked
         FROM deliveries WHERE id = $1 AND tenant_id = $2 AND event_id = $3`,
      [msg.deliveryId, msg.tenantId, msg.eventId],
    );
    const row = current.rows[0];
    if (!row) return { kind: 'missing' };
    // A duplicate of a message whose attempt is running right now: retry later
    // rather than drop it, in case the running worker dies.
    if (row.status === 'in_progress' && row.attempt_count === msg.attempt && row.locked)
      return { kind: 'busy' };
    return { kind: 'stale' };
  }

  async #attempt(
    msg: DeliveryRequestedV1,
    d: ClaimedDelivery,
    span: TraceContext,
  ): Promise<AttemptRecord> {
    const startedAt = new Date(this.#now());
    // Destination policy is re-checked on every attempt, not just at registration.
    const check = checkDestinationUrl(d.url, {
      allowInsecure: this.deps.allowInsecureDestinations,
    });
    const body = this.#body(msg, d);
    const result = check.ok
      ? await this.deps.http.post(check.url, this.#headers(msg, d, body, span), body)
      : ({ kind: 'error', code: 'DESTINATION_BLOCKED', durationMs: 0 } as const);
    return {
      startedAt,
      durationMs: result.durationMs,
      httpStatus: result.kind === 'response' ? result.status : null,
      classification: classify(result, this.#now()),
      traceId: span.traceId,
    };
  }

  #body(msg: DeliveryRequestedV1, d: ClaimedDelivery): string {
    return JSON.stringify({
      id: msg.eventId,
      type: d.event_type,
      createdAt: d.event_created_at.toISOString(),
      data: d.payload,
    });
  }

  #headers(
    msg: DeliveryRequestedV1,
    d: ClaimedDelivery,
    body: string,
    span: TraceContext,
  ): Record<string, string> {
    const timestamp = Math.floor(this.#now() / 1000);
    const secrets = [
      this.deps.keyring.decrypt({
        keyId: d.signing_secret_key_id,
        ciphertext: d.signing_secret_ciphertext,
      }),
    ];
    // During a rotation overlap window, also sign with the previous secret so
    // receivers that have not switched yet keep verifying (docs/webhooks.md).
    if (d.previous_signing_secret_ciphertext && d.previous_signing_secret_key_id) {
      secrets.push(
        this.deps.keyring.decrypt({
          keyId: d.previous_signing_secret_key_id,
          ciphertext: d.previous_signing_secret_ciphertext,
        }),
      );
    }
    return {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'relayforge-event-id': msg.eventId,
      'relayforge-delivery-id': msg.deliveryId,
      'relayforge-attempt': String(msg.attempt),
      'relayforge-timestamp': String(timestamp),
      'relayforge-signature': secrets
        .map((secret) => signPayload(secret, timestamp, body))
        .join(','),
      traceparent: formatTraceparent(span),
    };
  }

  /** Commit the outcome. Returns true when this attempt opened the endpoint's breaker. */
  async #persist(
    msg: DeliveryRequestedV1,
    endpointId: string,
    final: Final,
    attempt: AttemptRecord | null,
  ): Promise<boolean> {
    return withTransaction(this.deps.pool, async (tx) => {
      if (attempt) {
        await tx.query(
          `INSERT INTO delivery_attempts
             (tenant_id, delivery_id, attempt_number, started_at, finished_at, http_status, duration_ms, outcome, error_code, trace_id)
           VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)
           ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
          [
            msg.tenantId,
            msg.deliveryId,
            msg.attempt,
            attempt.startedAt,
            attempt.httpStatus,
            attempt.durationMs,
            attempt.classification.outcome,
            attempt.classification.errorCode,
            attempt.traceId,
          ],
        );
      }
      const updated = await tx.query(
        `UPDATE deliveries
            SET status = $4,
                next_attempt_at = $5,
                succeeded_at = CASE WHEN $4 = 'succeeded' THEN now() ELSE succeeded_at END,
                dead_letter_reason = $6,
                locked_until = NULL,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'in_progress' AND attempt_count = $3`,
        [
          msg.deliveryId,
          msg.tenantId,
          msg.attempt,
          final.status,
          final.status === 'retry_scheduled' ? final.nextAttemptAt : null,
          final.status === 'dead_lettered' ? final.reason : null,
        ],
      );
      if (updated.rowCount === 0) throw new LeaseLostError();
      await refreshEventStatus(tx, msg.tenantId, msg.eventId);
      return attempt ? this.#updateBreaker(tx, endpointId, attempt.classification) : false;
    });
  }

  /**
   * Endpoint circuit breaker. Retryable failures (timeouts, network errors,
   * 429/5xx) count towards suspension; a success closes it. Permanent
   * failures are usually specific to one event and do not count.
   */
  async #updateBreaker(tx: Queryable, endpointId: string, c: Classification): Promise<boolean> {
    if (c.outcome === 'succeeded') {
      await tx.query(
        `UPDATE webhook_endpoints SET consecutive_failures = 0, suppressed_until = NULL
          WHERE id = $1 AND (consecutive_failures > 0 OR suppressed_until IS NOT NULL)`,
        [endpointId],
      );
      return false;
    }
    if (c.outcome !== 'retryable_failure') return false;
    const { failureThreshold, suspensionMs } = this.#fairness;
    const { rows } = await tx.query<{ opened: boolean }>(
      `UPDATE webhook_endpoints
          SET consecutive_failures = consecutive_failures + 1,
              suppressed_until = CASE
                WHEN $2 > 0 AND consecutive_failures + 1 >= $2
                THEN now() + make_interval(secs => $3::double precision / 1000)
                ELSE suppressed_until END
        WHERE id = $1
    RETURNING $2 > 0 AND consecutive_failures >= $2 AS opened`,
      [endpointId, failureThreshold, suspensionMs],
    );
    return rows[0]?.opened ?? false;
  }

  #record(final: Final, attempt: AttemptRecord | null, breakerOpened: boolean): void {
    metrics.deliveries.inc({ outcome: final.status });
    if (final.status === 'retry_scheduled') metrics.retries.inc();
    if (breakerOpened) metrics.endpointSuppressions.inc();
    if (!attempt) return;
    metrics.attemptDuration.observe(
      { outcome: attempt.classification.outcome },
      attempt.durationMs,
    );
    if (attempt.classification.errorCode === 'TIMEOUT') metrics.destinationTimeouts.inc();
  }
}
