import { AppError } from '@relayforge/contracts';
import { enqueueDeliveries, withTransaction, type PoolClient } from '@relayforge/database';
import { formatTraceparent, metrics } from '@relayforge/observability';
import { fingerprint, sha256Hex, canonicalJson } from '@relayforge/security';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { tenantOf } from '../auth.js';
import type { AppDeps } from '../app.js';

const MAX_JSON_DEPTH = 32;

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== 'object') return depth;
  let max = depth + 1;
  for (const child of Object.values(value)) max = Math.max(max, jsonDepth(child, depth + 1));
  return max;
}

const PublishBody = z
  .object({
    type: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/,
        'must be dot-separated segments of [A-Za-z0-9_-]',
      ),
    data: z
      .record(z.unknown())
      .refine(
        (d) => jsonDepth(d) <= MAX_JSON_DEPTH,
        `must not be nested deeper than ${MAX_JSON_DEPTH} levels`,
      ),
    endpointIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  })
  .strict();

const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without spaces')
    .optional(),
});

const Accepted = z.object({
  eventId: z.string().uuid(),
  status: z.literal('accepted'),
  acceptedAt: z.string(),
  statusUrl: z.string(),
});

const EventView = z.object({
  id: z.string().uuid(),
  type: z.string(),
  status: z.string(),
  createdAt: z.string(),
  data: z.record(z.unknown()),
  deliveries: z.array(
    z.object({
      id: z.string().uuid(),
      endpointId: z.string().uuid(),
      status: z.string(),
      attemptCount: z.number().int(),
      replayOfDeliveryId: z.string().uuid().nullable(),
    }),
  ),
});

function accepted(eventId: string, createdAt: Date): z.infer<typeof Accepted> {
  return {
    eventId,
    status: 'accepted',
    acceptedAt: createdAt.toISOString(),
    statusUrl: `/v1/events/${eventId}`,
  };
}

async function resolveTargets(
  tx: PoolClient,
  tenantId: string,
  endpointIds: string[] | undefined,
): Promise<string[]> {
  if (!endpointIds) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at`,
      [tenantId],
    );
    if (rows.length === 0)
      throw new AppError('NO_ACTIVE_ENDPOINTS', 'Tenant has no active endpoints');
    return rows.map((r) => r.id);
  }
  const unique = [...new Set(endpointIds)];
  // Lock the endpoints so a concurrent disable cannot interleave with acceptance.
  const { rows } = await tx.query<{ id: string; status: string }>(
    `SELECT id, status FROM webhook_endpoints WHERE tenant_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
    [tenantId, unique],
  );
  // Endpoints owned by other tenants are indistinguishable from missing ones.
  if (rows.length !== unique.length)
    throw new AppError('NOT_FOUND', 'One or more endpoints were not found');
  if (rows.some((r) => r.status !== 'active')) {
    throw new AppError('ENDPOINT_DISABLED', 'One or more endpoints are disabled');
  }
  return unique;
}

export function eventRoutes({ pool, config }: AppDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/events',
      {
        config: { scope: 'events:write' },
        schema: {
          tags: ['events'],
          summary: 'Accept an event for asynchronous delivery.',
          description:
            'Returns 202 only after the event, its deliveries and outbox records are committed. ' +
            'Repeating a request with the same Idempotency-Key returns the original result; ' +
            'reusing a key with a different request returns 409.',
          headers: IdempotencyHeaders,
          body: PublishBody,
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const { tenantId } = tenantOf(request);
        const { type, data, endpointIds } = request.body;
        const idempotencyKey = request.headers['idempotency-key'] ?? null;

        const payloadJson = canonicalJson(data);
        if (Buffer.byteLength(payloadJson, 'utf8') > config.MAX_EVENT_PAYLOAD_BYTES) {
          throw new AppError(
            'PAYLOAD_TOO_LARGE',
            `data exceeds ${config.MAX_EVENT_PAYLOAD_BYTES} bytes`,
          );
        }
        const requestFingerprint = fingerprint({
          type,
          data,
          endpointIds: endpointIds ? [...new Set(endpointIds)].sort() : null,
        });

        const traceparent = formatTraceparent(request.trace);
        const result = await withTransaction(pool, async (tx) => {
          // Insert first: a concurrent request with the same key blocks on the
          // unique index until this transaction ends, then sees the winner.
          const inserted = await tx.query<{ id: string; created_at: Date }>(
            `INSERT INTO events (tenant_id, event_type, payload, payload_hash, request_fingerprint, idempotency_key, traceparent)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
             RETURNING id, created_at`,
            [
              tenantId,
              type,
              payloadJson,
              sha256Hex(payloadJson),
              requestFingerprint,
              idempotencyKey,
              traceparent,
            ],
          );

          const event = inserted.rows[0];
          if (!event) {
            const { rows } = await tx.query<{
              id: string;
              created_at: Date;
              request_fingerprint: string;
            }>(
              `SELECT id, created_at, request_fingerprint FROM events WHERE tenant_id = $1 AND idempotency_key = $2`,
              [tenantId, idempotencyKey],
            );
            const original = rows[0]!;
            if (original.request_fingerprint !== requestFingerprint) {
              throw new AppError(
                'IDEMPOTENCY_KEY_REUSED',
                'Idempotency-Key was already used with a different request',
              );
            }
            return { replayed: true, event: original };
          }

          const targets = await resolveTargets(tx, tenantId, endpointIds);
          const { rows: deliveries } = await tx.query<{ id: string }>(
            `INSERT INTO deliveries (tenant_id, event_id, endpoint_id)
             SELECT $1, $2, unnest($3::uuid[]) RETURNING id`,
            [tenantId, event.id, targets],
          );
          await enqueueDeliveries(
            tx,
            deliveries.map((d) => ({
              deliveryId: d.id,
              tenantId,
              eventId: event.id,
              attempt: 1,
              traceparent,
            })),
          );
          return { replayed: false, event };
        });

        request.log.info(
          {
            operation: 'event.accept',
            event_id: result.event.id,
            idempotent_replay: result.replayed,
          },
          'event accepted',
        );
        if (result.replayed) reply.header('idempotent-replayed', 'true');
        else metrics.eventsAccepted.inc();
        return reply.status(202).send(accepted(result.event.id, result.event.created_at));
      },
    );

    app.get(
      '/events/:eventId',
      {
        config: { scope: 'events:read' },
        schema: {
          tags: ['events'],
          params: z.object({ eventId: z.string().uuid() }),
          response: { 200: EventView },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const { rows } = await pool.query<{
          id: string;
          event_type: string;
          status: string;
          created_at: Date;
          payload: Record<string, unknown>;
        }>(
          `SELECT id, event_type, status, created_at, payload FROM events WHERE tenant_id = $1 AND id = $2`,
          [tenantId, request.params.eventId],
        );
        const event = rows[0];
        if (!event) throw new AppError('NOT_FOUND', 'Event not found');
        const deliveries = await pool.query<{
          id: string;
          endpoint_id: string;
          status: string;
          attempt_count: number;
          replay_of_delivery_id: string | null;
        }>(
          `SELECT id, endpoint_id, status, attempt_count, replay_of_delivery_id
             FROM deliveries WHERE tenant_id = $1 AND event_id = $2 ORDER BY created_at, id`,
          [tenantId, event.id],
        );
        return {
          id: event.id,
          type: event.event_type,
          status: event.status,
          createdAt: event.created_at.toISOString(),
          data: event.payload,
          deliveries: deliveries.rows.map((d) => ({
            id: d.id,
            endpointId: d.endpoint_id,
            status: d.status,
            attemptCount: d.attempt_count,
            replayOfDeliveryId: d.replay_of_delivery_id,
          })),
        };
      },
    );
  };
}
