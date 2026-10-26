import type { Pool } from '@relayforge/database';
import { fullJitterBackoff, type QueueSender } from '@relayforge/messaging';
import { errorFields, type Logger } from '@relayforge/observability';

export interface OutboxRelayOptions {
  owner: string;
  batchSize: number;
  leaseMs: number;
  retryBaseMs?: number;
  retryCapMs?: number;
}

interface ClaimedRow {
  id: string;
  event_id: string;
  message_type: string;
  payload: unknown;
  attempt_count: number;
}

/**
 * Moves committed outbox rows to the broker (design §8.1, §8.4):
 * 1. claim a bounded batch with a lease (FOR UPDATE SKIP LOCKED) and commit;
 * 2. publish with message id = outbox id, outside any transaction;
 * 3. mark published only after the broker acknowledged.
 * A crash between 2 and 3 republishes the same message id; consumers are idempotent.
 */
export class OutboxRelay {
  constructor(
    private readonly pool: Pool,
    private readonly sender: QueueSender,
    private readonly logger: Logger,
    private readonly opts: OutboxRelayOptions,
  ) {}

  /** Relay one batch. Returns the number of rows published. */
  async relayOnce(): Promise<number> {
    const { rows } = await this.pool.query<ClaimedRow>(
      `UPDATE outbox_events o
          SET locked_by = $1,
              locked_until = now() + make_interval(secs => $2::double precision / 1000),
              attempt_count = o.attempt_count + 1
        WHERE o.id IN (
                SELECT id FROM outbox_events
                 WHERE published_at IS NULL
                   AND next_attempt_at <= now()
                   AND (locked_until IS NULL OR locked_until < now())
                 ORDER BY next_attempt_at, created_at
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.event_id, o.message_type, o.payload, o.attempt_count`,
      [this.opts.owner, this.opts.leaseMs, this.opts.batchSize],
    );
    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    try {
      await this.sender.send(
        rows.map((r) => ({
          messageId: r.id,
          subject: r.message_type,
          body: r.payload,
          correlationId: r.event_id,
        })),
      );
    } catch (error) {
      const attempts = Math.max(...rows.map((r) => r.attempt_count));
      const delayMs = fullJitterBackoff(
        attempts,
        this.opts.retryBaseMs ?? 1_000,
        this.opts.retryCapMs ?? 60_000,
      );
      await this.pool.query(
        `UPDATE outbox_events
            SET locked_by = NULL, locked_until = NULL, last_error_code = $3,
                next_attempt_at = now() + make_interval(secs => $4::double precision / 1000)
          WHERE id = ANY($1::uuid[]) AND locked_by = $2 AND published_at IS NULL`,
        [ids, this.opts.owner, 'BROKER_UNAVAILABLE', delayMs],
      );
      this.logger.warn(
        {
          ...errorFields(error),
          operation: 'outbox.publish',
          outcome: 'failed',
          batch_size: rows.length,
          retry_in_ms: delayMs,
        },
        'outbox publish failed; will retry',
      );
      return 0;
    }

    await this.pool.query(
      `UPDATE outbox_events SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error_code = NULL
        WHERE id = ANY($1::uuid[]) AND locked_by = $2`,
      [ids, this.opts.owner],
    );
    this.logger.debug(
      { operation: 'outbox.publish', outcome: 'published', batch_size: rows.length },
      'outbox batch published',
    );
    return rows.length;
  }

  /** Backlog gauges for alerting on outbox age (design §10.2). */
  async backlog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const { rows } = await this.pool.query<{ pending: number; oldest: number | null }>(
      `SELECT count(*)::int AS pending, extract(epoch FROM now() - min(created_at))::float AS oldest
         FROM outbox_events WHERE published_at IS NULL`,
    );
    return { pending: rows[0]?.pending ?? 0, oldestAgeSeconds: Math.round(rows[0]?.oldest ?? 0) };
  }
}
