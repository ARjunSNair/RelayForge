import type { Pool } from '@relayforge/database';

/**
 * Due-work scheduler (design §8.3). Workers never sleep through backoff; they
 * persist next_attempt_at, and this moves due deliveries back to `queued` and
 * writes a fresh outbox message carrying the next attempt number — all in one
 * statement, so state and message cannot diverge.
 */
export async function enqueueDueRetries(pool: Pool, limit: number): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH due AS (
       SELECT id FROM deliveries
        WHERE status = 'retry_scheduled' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), requeued AS (
       UPDATE deliveries d
          SET status = 'queued', next_attempt_at = NULL, updated_at = now()
         FROM due WHERE d.id = due.id
       RETURNING d.id, d.tenant_id, d.event_id, d.attempt_count
     )
     INSERT INTO outbox_events (tenant_id, event_id, message_type, payload)
     SELECT tenant_id, event_id, 'delivery.requested',
            jsonb_build_object('version', 1, 'deliveryId', id, 'tenantId', tenant_id,
                               'eventId', event_id, 'attempt', attempt_count + 1)
       FROM requeued`,
    [limit],
  );
  return rowCount ?? 0;
}

/**
 * Recover deliveries whose worker died mid-attempt: the lease expired while
 * still `in_progress` and no outcome was recorded. The attempt is re-executed
 * under the same attempt number (attempt_count is rolled back by one so the
 * normal claim path applies). The destination may see a duplicate; receivers
 * deduplicate by event id (at-least-once, design §7.4).
 */
export async function recoverStalledDeliveries(pool: Pool, limit: number): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH stalled AS (
       SELECT id FROM deliveries
        WHERE status = 'in_progress' AND locked_until < now()
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), requeued AS (
       UPDATE deliveries d
          SET status = 'queued', attempt_count = d.attempt_count - 1, locked_until = NULL, updated_at = now()
         FROM stalled WHERE d.id = stalled.id
       RETURNING d.id, d.tenant_id, d.event_id, d.attempt_count
     )
     INSERT INTO outbox_events (tenant_id, event_id, message_type, payload)
     SELECT tenant_id, event_id, 'delivery.requested',
            jsonb_build_object('version', 1, 'deliveryId', id, 'tenantId', tenant_id,
                               'eventId', event_id, 'attempt', attempt_count + 1)
       FROM requeued`,
    [limit],
  );
  return rowCount ?? 0;
}
