import type { Queryable } from './index.js';

export interface DeliveryToEnqueue {
  deliveryId: string;
  tenantId: string;
  eventId: string;
  /** Attempt number the resulting message is allowed to execute. */
  attempt: number;
  /** Trace context of the operation that requested the delivery. */
  traceparent?: string | null;
}

/**
 * Write `delivery.requested` outbox rows. Must run in the same transaction as
 * the delivery state change it announces (transactional outbox, design §8.1).
 * The payload shape is `DeliveryRequestedV1` from @relayforge/contracts.
 */
export async function enqueueDeliveries(db: Queryable, items: DeliveryToEnqueue[]): Promise<void> {
  if (items.length === 0) return;
  await db.query(
    `INSERT INTO outbox_events (tenant_id, event_id, message_type, payload, traceparent)
     SELECT t.tenant_id, t.event_id, 'delivery.requested',
            jsonb_build_object('version', 1, 'deliveryId', t.delivery_id, 'tenantId', t.tenant_id,
                               'eventId', t.event_id, 'attempt', t.attempt),
            t.traceparent
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[], $5::text[])
            AS t(delivery_id, tenant_id, event_id, attempt, traceparent)`,
    [
      items.map((i) => i.deliveryId),
      items.map((i) => i.tenantId),
      items.map((i) => i.eventId),
      items.map((i) => i.attempt),
      items.map((i) => i.traceparent ?? null),
    ],
  );
}

/**
 * Recompute an event's aggregate status from the latest delivery execution per
 * endpoint (so a successful replay supersedes the dead-lettered original).
 */
export async function refreshEventStatus(
  db: Queryable,
  tenantId: string,
  eventId: string,
): Promise<void> {
  await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (endpoint_id) status
         FROM deliveries
        WHERE tenant_id = $1 AND event_id = $2
        ORDER BY endpoint_id, created_at DESC, id DESC
     ), counts AS (
       SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
              count(*) FILTER (WHERE status IN ('queued', 'in_progress', 'retry_scheduled')) AS active
         FROM latest
     )
     UPDATE events e
        SET status = CASE
              WHEN c.active > 0 THEN 'processing'
              WHEN c.succeeded = c.total THEN 'completed'
              WHEN c.succeeded > 0 THEN 'partially_delivered'
              ELSE 'failed'
            END
       FROM counts c
      WHERE e.tenant_id = $1 AND e.id = $2 AND c.total > 0`,
    [tenantId, eventId],
  );
}
