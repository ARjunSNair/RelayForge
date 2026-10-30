import type { Pool } from '@relayforge/database';

export interface RetentionPolicy {
  /** Finished events (and their deliveries, attempts and outbox rows) older than this are deleted. */
  eventDays: number;
  /** Published outbox rows are kept this long for diagnosis. */
  outboxHours: number;
  /** Dead-lettered local queue messages (Postgres transport only). */
  queueDeadLetterDays: number;
  /** Upper bound on rows selected per statement, so deletes stay short. */
  batchSize: number;
}

export type RetentionCounts = Record<
  | 'events'
  | 'deliveries'
  | 'delivery_attempts'
  | 'outbox_events'
  | 'local_queue_messages'
  | 'rate_limit_counters',
  number
>;

/**
 * Retention (design §5.3, §9.4). Deletes in bounded batches; call repeatedly
 * until a pass removes nothing. Events are only removed once no delivery is
 * still active, together with their whole history. Audit events are kept.
 */
export async function runRetention(pool: Pool, policy: RetentionPolicy): Promise<RetentionCounts> {
  const events = await pool.query<{
    events: number;
    deliveries: number;
    attempts: number;
    outbox: number;
  }>(
    `WITH doomed AS (
       SELECT e.id FROM events e
        WHERE e.created_at < now() - make_interval(days => $1)
          AND NOT EXISTS (
                SELECT 1 FROM deliveries d
                 WHERE d.event_id = e.id AND d.status IN ('queued', 'in_progress', 'retry_scheduled'))
        ORDER BY e.created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), attempts AS (
       DELETE FROM delivery_attempts a USING deliveries d, doomed
        WHERE a.delivery_id = d.id AND d.event_id = doomed.id
       RETURNING 1
     ), deliveries AS (
       DELETE FROM deliveries d USING doomed WHERE d.event_id = doomed.id RETURNING 1
     ), outbox AS (
       DELETE FROM outbox_events o USING doomed WHERE o.event_id = doomed.id RETURNING 1
     ), events AS (
       DELETE FROM events e USING doomed WHERE e.id = doomed.id RETURNING 1
     )
     SELECT (SELECT count(*) FROM events)::int AS events,
            (SELECT count(*) FROM deliveries)::int AS deliveries,
            (SELECT count(*) FROM attempts)::int AS attempts,
            (SELECT count(*) FROM outbox)::int AS outbox`,
    [policy.eventDays, policy.batchSize],
  );

  const outbox = await pool.query(
    `DELETE FROM outbox_events WHERE id IN (
       SELECT id FROM outbox_events
        WHERE published_at < now() - make_interval(hours => $1)
        ORDER BY published_at LIMIT $2)`,
    [policy.outboxHours, policy.batchSize],
  );

  const queue = await pool.query(
    `DELETE FROM local_queue_messages WHERE (queue, message_id) IN (
       SELECT queue, message_id FROM local_queue_messages
        WHERE dead_lettered_at < now() - make_interval(days => $1)
        LIMIT $2)`,
    [policy.queueDeadLetterDays, policy.batchSize],
  );

  const counters = await pool.query(
    `DELETE FROM rate_limit_counters WHERE (key, window_start) IN (
       SELECT key, window_start FROM rate_limit_counters WHERE expires_at < now() LIMIT $1)`,
    [policy.batchSize * 10],
  );

  const e = events.rows[0]!;
  return {
    events: e.events,
    deliveries: e.deliveries,
    delivery_attempts: e.attempts,
    outbox_events: e.outbox + (outbox.rowCount ?? 0),
    local_queue_messages: queue.rowCount ?? 0,
    rate_limit_counters: counters.rowCount ?? 0,
  };
}
