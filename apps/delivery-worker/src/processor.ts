import {
  DELIVERY_REQUESTED,
  DeliveryRequestedV1,
  type DeadLetterReason,
} from '@relayforge/contracts';
import { refreshEventStatus, withTransaction, type Pool } from '@relayforge/database';
import type { ReceivedMessage } from '@relayforge/messaging';
import type { Logger } from '@relayforge/observability';
import { checkDestinationUrl, signPayload, type SecretBox } from '@relayforge/security';
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

export interface ProcessorDeps {
  pool: Pool;
  secretBox: SecretBox;
  http: Pick<WebhookHttpClient, 'post'>;
  logger: Logger;
  retry: RetrySettings;
  /** Lease on an in_progress delivery; must exceed the HTTP timeout. */
  leaseMs: number;
  allowInsecureDestinations: boolean;
  now?: () => number;
  random?: () => number;
}

interface ClaimedDelivery {
  id: string;
  event_type: string;
  payload: unknown;
  event_created_at: Date;
  url: string;
  endpoint_status: 'active' | 'disabled';
  signing_secret_ciphertext: Buffer;
}

type Final = NextState | { status: 'cancelled' };

interface AttemptRecord {
  startedAt: Date;
  durationMs: number;
  httpStatus: number | null;
  classification: Classification;
}

/** Another execution took over this delivery (lease expired and was recovered). */
class LeaseLostError extends Error {}

const USER_AGENT = 'RelayForge-Webhooks/0.1';

/**
 * Handles one `delivery.requested` message (design §8.2):
 * validate → claim (fenced by attempt number) → POST → persist outcome → settle.
 * The message is completed only after the outcome is committed; any failure to
 * persist leaves it to be redelivered.
 */
export class DeliveryProcessor {
  readonly #now: () => number;

  constructor(private readonly deps: ProcessorDeps) {
    this.#now = deps.now ?? Date.now;
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
    const log = this.deps.logger.child({
      tenant_id: msg.tenantId,
      event_id: msg.eventId,
      delivery_id: msg.deliveryId,
      attempt: msg.attempt,
    });

    const claimed = await this.#claim(msg);
    if (claimed.kind !== 'claimed') {
      log.info({ operation: 'delivery.claim', outcome: claimed.kind }, 'delivery not claimable');
      if (claimed.kind === 'busy') return { action: 'abandon', delayMs: 5_000 };
      if (claimed.kind === 'missing') return { action: 'dead_letter', reason: 'INVALID_MESSAGE' };
      // Stale or duplicate message: a newer attempt owns the delivery, or it is finished.
      return { action: 'complete' };
    }
    const d = claimed.delivery;

    let final: Final;
    let attempt: AttemptRecord | null = null;
    if (d.endpoint_status !== 'active') {
      final = { status: 'cancelled' };
    } else if (this.#now() > d.event_created_at.getTime() + this.deps.retry.maxEventAgeMs) {
      final = { status: 'dead_lettered', reason: 'EVENT_EXPIRED' };
    } else {
      attempt = await this.#attempt(msg, d);
      final = decideNext(
        attempt.classification,
        { attempt: msg.attempt, eventCreatedAt: d.event_created_at, now: this.#now() },
        this.deps.retry,
        this.deps.random,
      );
    }

    try {
      await this.#persist(msg, final, attempt);
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

  async #claim(
    msg: DeliveryRequestedV1,
  ): Promise<
    { kind: 'claimed'; delivery: ClaimedDelivery } | { kind: 'busy' | 'stale' | 'missing' }
  > {
    const { rows } = await this.deps.pool.query<ClaimedDelivery>(
      `WITH claimed AS (
         UPDATE deliveries d
            SET status = 'in_progress', attempt_count = $4, last_attempt_at = now(),
                locked_until = now() + make_interval(secs => $5::double precision / 1000), updated_at = now()
          WHERE d.id = $1 AND d.tenant_id = $2 AND d.event_id = $3
            AND d.status = 'queued' AND d.attempt_count = $4 - 1
        RETURNING d.id, d.event_id, d.endpoint_id
       )
       SELECT c.id, e.event_type, e.payload, e.created_at AS event_created_at,
              w.url, w.status AS endpoint_status, w.signing_secret_ciphertext
         FROM claimed c
         JOIN events e ON e.id = c.event_id
         JOIN webhook_endpoints w ON w.id = c.endpoint_id`,
      [msg.deliveryId, msg.tenantId, msg.eventId, msg.attempt, this.deps.leaseMs],
    );
    if (rows[0]) return { kind: 'claimed', delivery: rows[0] };

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

  async #attempt(msg: DeliveryRequestedV1, d: ClaimedDelivery): Promise<AttemptRecord> {
    const startedAt = new Date(this.#now());
    // Destination policy is re-checked on every attempt, not just at registration.
    const check = checkDestinationUrl(d.url, {
      allowInsecure: this.deps.allowInsecureDestinations,
    });
    const body = this.#body(msg, d);
    const result = check.ok
      ? await this.deps.http.post(check.url, this.#headers(msg, d, body), body)
      : ({ kind: 'error', code: 'DESTINATION_BLOCKED', durationMs: 0 } as const);
    return {
      startedAt,
      durationMs: result.durationMs,
      httpStatus: result.kind === 'response' ? result.status : null,
      classification: classify(result, this.#now()),
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

  #headers(msg: DeliveryRequestedV1, d: ClaimedDelivery, body: string): Record<string, string> {
    const timestamp = Math.floor(this.#now() / 1000);
    const secret = this.deps.secretBox.decrypt(d.signing_secret_ciphertext);
    return {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'relayforge-event-id': msg.eventId,
      'relayforge-delivery-id': msg.deliveryId,
      'relayforge-attempt': String(msg.attempt),
      'relayforge-timestamp': String(timestamp),
      'relayforge-signature': signPayload(secret, timestamp, body),
    };
  }

  async #persist(
    msg: DeliveryRequestedV1,
    final: Final,
    attempt: AttemptRecord | null,
  ): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      if (attempt) {
        await tx.query(
          `INSERT INTO delivery_attempts
             (tenant_id, delivery_id, attempt_number, started_at, finished_at, http_status, duration_ms, outcome, error_code)
           VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8)
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
    });
  }
}
