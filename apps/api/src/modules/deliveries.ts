import { AppError, DELIVERY_STATUSES } from '@relayforge/contracts';
import { enqueueDeliveries, refreshEventStatus, withTransaction } from '@relayforge/database';
import { formatTraceparent } from '@relayforge/observability';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { tenantOf } from '../auth.js';
import { decodeCursor, encodeCursor } from '../pagination.js';
import type { AppDeps } from '../app.js';

const DeliveryView = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  endpointId: z.string().uuid(),
  status: z.enum(DELIVERY_STATUSES),
  attemptCount: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  succeededAt: z.string().nullable(),
  deadLetterReason: z.string().nullable(),
  replayOfDeliveryId: z.string().uuid().nullable(),
  createdAt: z.string(),
});

const AttemptView = z.object({
  attemptNumber: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: z.string(),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  /** W3C trace id shared by the API request, worker logs and the outbound request. */
  traceId: z.string().nullable(),
});

interface DeliveryRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  status: (typeof DELIVERY_STATUSES)[number];
  attempt_count: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  succeeded_at: Date | null;
  dead_letter_reason: string | null;
  replay_of_delivery_id: string | null;
  created_at: Date;
  created_at_text: string;
}

const COLUMNS = `id, event_id, endpoint_id, status, attempt_count, next_attempt_at, last_attempt_at,
  succeeded_at, dead_letter_reason, replay_of_delivery_id, created_at, created_at::text AS created_at_text`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toView(r: DeliveryRow): z.infer<typeof DeliveryView> {
  return {
    id: r.id,
    eventId: r.event_id,
    endpointId: r.endpoint_id,
    status: r.status,
    attemptCount: r.attempt_count,
    nextAttemptAt: iso(r.next_attempt_at),
    lastAttemptAt: iso(r.last_attempt_at),
    succeededAt: iso(r.succeeded_at),
    deadLetterReason: r.dead_letter_reason,
    replayOfDeliveryId: r.replay_of_delivery_id,
    createdAt: r.created_at.toISOString(),
  };
}

const IdParams = z.object({ deliveryId: z.string().uuid() });

export function deliveryRoutes({ pool, config }: AppDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/deliveries',
      {
        config: { scope: 'deliveries:read' },
        schema: {
          tags: ['deliveries'],
          summary: 'Search deliveries, newest first, with cursor pagination.',
          querystring: z
            .object({
              status: z.enum(DELIVERY_STATUSES).optional(),
              eventId: z.string().uuid().optional(),
              endpointId: z.string().uuid().optional(),
              cursor: z.string().max(200).optional(),
              limit: z.coerce.number().int().min(1).max(100).default(50),
            })
            .strict(),
          response: {
            200: z.object({ data: z.array(DeliveryView), nextCursor: z.string().nullable() }),
          },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const { status, eventId, endpointId, cursor, limit } = request.query;
        const after = cursor ? decodeCursor(cursor) : null;
        const { rows } = await pool.query<DeliveryRow>(
          `SELECT ${COLUMNS} FROM deliveries
            WHERE tenant_id = $1
              AND ($2::text IS NULL OR status = $2)
              AND ($3::uuid IS NULL OR event_id = $3)
              AND ($4::uuid IS NULL OR endpoint_id = $4)
              AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
            ORDER BY created_at DESC, id DESC
            LIMIT $7`,
          [
            tenantId,
            status ?? null,
            eventId ?? null,
            endpointId ?? null,
            after?.createdAt ?? null,
            after?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          data: page.map(toView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ createdAt: last.created_at_text, id: last.id })
              : null,
        };
      },
    );

    app.get(
      '/deliveries/:deliveryId',
      {
        config: { scope: 'deliveries:read' },
        schema: {
          tags: ['deliveries'],
          params: IdParams,
          response: { 200: DeliveryView.extend({ attempts: z.array(AttemptView) }) },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const { rows } = await pool.query<DeliveryRow>(
          `SELECT ${COLUMNS} FROM deliveries WHERE tenant_id = $1 AND id = $2`,
          [tenantId, request.params.deliveryId],
        );
        if (!rows[0]) throw new AppError('NOT_FOUND', 'Delivery not found');
        const attempts = await pool.query<{
          attempt_number: number;
          started_at: Date;
          finished_at: Date | null;
          outcome: string;
          http_status: number | null;
          duration_ms: number | null;
          error_code: string | null;
          trace_id: string | null;
        }>(
          `SELECT attempt_number, started_at, finished_at, outcome, http_status, duration_ms, error_code, trace_id
             FROM delivery_attempts WHERE tenant_id = $1 AND delivery_id = $2 ORDER BY attempt_number`,
          [tenantId, rows[0].id],
        );
        return {
          ...toView(rows[0]),
          attempts: attempts.rows.map((a) => ({
            attemptNumber: a.attempt_number,
            startedAt: a.started_at.toISOString(),
            finishedAt: iso(a.finished_at),
            outcome: a.outcome,
            httpStatus: a.http_status,
            durationMs: a.duration_ms,
            errorCode: a.error_code,
            traceId: a.trace_id,
          })),
        };
      },
    );

    app.post(
      '/deliveries/:deliveryId/replay',
      {
        config: { scope: 'deliveries:replay' },
        schema: {
          tags: ['deliveries'],
          summary: 'Replay a dead-lettered delivery as a new, linked delivery execution.',
          params: IdParams,
          response: { 202: DeliveryView },
        },
      },
      async (request, reply) => {
        const { tenantId } = tenantOf(request);
        const replay = await withTransaction(pool, async (tx) => {
          // Row lock serialises concurrent replays of the same delivery.
          const { rows } = await tx.query<{
            id: string;
            event_id: string;
            endpoint_id: string;
            status: string;
            endpoint_status: string;
          }>(
            `SELECT d.id, d.event_id, d.endpoint_id, d.status, e.status AS endpoint_status
               FROM deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
              WHERE d.tenant_id = $1 AND d.id = $2
              FOR UPDATE OF d`,
            [tenantId, request.params.deliveryId],
          );
          const original = rows[0];
          if (!original) throw new AppError('NOT_FOUND', 'Delivery not found');
          if (original.status !== 'dead_lettered') {
            throw new AppError(
              'DELIVERY_NOT_REPLAYABLE',
              'Only dead-lettered deliveries can be replayed',
            );
          }
          if (original.endpoint_status !== 'active') {
            throw new AppError('ENDPOINT_DISABLED', 'Endpoint is disabled');
          }
          const count = await tx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM deliveries WHERE replay_of_delivery_id = $1',
            [original.id],
          );
          if (count.rows[0]!.n >= config.MAX_REPLAYS_PER_DELIVERY) {
            throw new AppError(
              'REPLAY_LIMIT_EXCEEDED',
              'Replay limit for this delivery has been reached',
            );
          }

          const inserted = await tx.query<DeliveryRow>(
            `INSERT INTO deliveries (tenant_id, event_id, endpoint_id, replay_of_delivery_id)
             VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
            [tenantId, original.event_id, original.endpoint_id, original.id],
          );
          const created = inserted.rows[0]!;
          await enqueueDeliveries(tx, [
            {
              deliveryId: created.id,
              tenantId,
              eventId: created.event_id,
              attempt: 1,
              traceparent: formatTraceparent(request.trace),
            },
          ]);
          await refreshEventStatus(tx, tenantId, created.event_id);
          await recordAudit(tx, request, 'delivery.replayed', {
            type: 'delivery',
            id: original.id,
          });
          return created;
        });
        request.log.info(
          {
            operation: 'delivery.replay',
            delivery_id: replay.id,
            replay_of: replay.replay_of_delivery_id,
          },
          'delivery replay accepted',
        );
        return reply.status(202).send(toView(replay));
      },
    );
  };
}
