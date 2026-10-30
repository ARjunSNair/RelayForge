import { AppError } from '@relayforge/contracts';
import { withTransaction } from '@relayforge/database';
import { checkDestinationUrl, generateSigningSecret } from '@relayforge/security';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { tenantOf } from '../auth.js';
import type { AppDeps } from '../app.js';

const EndpointView = z.object({
  id: z.string().uuid(),
  url: z.string(),
  description: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  /** Concurrent attempts allowed; null means the platform default. */
  maxConcurrency: z.number().int().nullable(),
  /** While set and in the future, deliveries are also signed with the previous secret. */
  previousSecretExpiresAt: z.string().nullable(),
  health: z.object({
    consecutiveFailures: z.number().int(),
    /** Deliveries are paused until then after repeated failures (circuit breaker). */
    suppressedUntil: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const MaxConcurrency = z.number().int().min(1).max(100);
/** Longest allowed signing-secret overlap during rotation: 7 days. */
const MAX_OVERLAP_SECONDS = 7 * 24 * 3600;

const IdParams = z.object({ endpointId: z.string().uuid() });

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  status: 'active' | 'disabled';
  max_concurrency: number | null;
  previous_secret_expires_at: Date | null;
  consecutive_failures: number;
  suppressed_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, url, description, status, max_concurrency, previous_secret_expires_at,
  consecutive_failures, suppressed_until, created_at, updated_at`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toView(row: EndpointRow): z.infer<typeof EndpointView> {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    status: row.status,
    maxConcurrency: row.max_concurrency,
    previousSecretExpiresAt: iso(row.previous_secret_expires_at),
    health: {
      consecutiveFailures: row.consecutive_failures,
      suppressedUntil: iso(row.suppressed_until),
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function endpointRoutes({ pool, config, keyring }: AppDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/endpoints',
      {
        config: { scope: 'endpoints:write' },
        schema: {
          tags: ['endpoints'],
          summary: 'Register a webhook endpoint. The signing secret is returned only once.',
          body: z
            .object({
              url: z.string().max(2048),
              description: z.string().max(500).optional(),
              maxConcurrency: MaxConcurrency.optional(),
            })
            .strict(),
          response: { 201: EndpointView.extend({ signingSecret: z.string() }) },
        },
      },
      async (request, reply) => {
        const { tenantId } = tenantOf(request);
        const check = checkDestinationUrl(request.body.url, {
          allowInsecure: config.ALLOW_INSECURE_DESTINATIONS,
        });
        if (!check.ok) throw new AppError('DESTINATION_NOT_ALLOWED', check.reason);

        const signingSecret = generateSigningSecret();
        const sealed = keyring.encrypt(signingSecret);
        const row = await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<EndpointRow>(
            `INSERT INTO webhook_endpoints
               (tenant_id, url, description, signing_secret_ciphertext, signing_secret_key_id, max_concurrency)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
            [
              tenantId,
              check.url.toString(),
              request.body.description ?? null,
              sealed.ciphertext,
              sealed.keyId,
              request.body.maxConcurrency ?? null,
            ],
          );
          const created = rows[0]!;
          await recordAudit(tx, request, 'endpoint.created', { type: 'endpoint', id: created.id });
          return created;
        });
        return reply.status(201).send({ ...toView(row), signingSecret });
      },
    );

    app.get(
      '/endpoints',
      {
        config: { scope: 'endpoints:read' },
        schema: {
          tags: ['endpoints'],
          summary: 'List endpoints (most recent 100).',
          response: { 200: z.object({ data: z.array(EndpointView) }) },
        },
      },
      async (request) => {
        const { rows } = await pool.query<EndpointRow>(
          `SELECT ${COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [tenantOf(request).tenantId],
        );
        return { data: rows.map(toView) };
      },
    );

    app.get(
      '/endpoints/:endpointId',
      {
        config: { scope: 'endpoints:read' },
        schema: { tags: ['endpoints'], params: IdParams, response: { 200: EndpointView } },
      },
      async (request) => {
        const { rows } = await pool.query<EndpointRow>(
          `SELECT ${COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2`,
          [tenantOf(request).tenantId, request.params.endpointId],
        );
        if (!rows[0]) throw new AppError('NOT_FOUND', 'Endpoint not found');
        return toView(rows[0]);
      },
    );

    app.patch(
      '/endpoints/:endpointId',
      {
        config: { scope: 'endpoints:write' },
        schema: {
          tags: ['endpoints'],
          summary: 'Update description, status or concurrency. URL changes are not supported.',
          description:
            'Setting status to active also clears the circuit breaker, so a suspended endpoint ' +
            'can be resumed immediately once the receiver is fixed.',
          params: IdParams,
          body: z
            .object({
              description: z.string().max(500).nullable().optional(),
              status: z.enum(['active', 'disabled']).optional(),
              maxConcurrency: MaxConcurrency.nullable().optional(),
            })
            .strict(),
          response: { 200: EndpointView },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const { description, status, maxConcurrency } = request.body;
        const row = await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<EndpointRow>(
            `UPDATE webhook_endpoints
                SET description = CASE WHEN $3 THEN $4 ELSE description END,
                    status = COALESCE($5, status),
                    max_concurrency = CASE WHEN $6 THEN $7 ELSE max_concurrency END,
                    consecutive_failures = CASE WHEN $5 = 'active' THEN 0 ELSE consecutive_failures END,
                    suppressed_until = CASE WHEN $5 = 'active' THEN NULL ELSE suppressed_until END,
                    updated_at = now()
              WHERE tenant_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
            [
              tenantId,
              request.params.endpointId,
              description !== undefined,
              description ?? null,
              status ?? null,
              maxConcurrency !== undefined,
              maxConcurrency ?? null,
            ],
          );
          if (!rows[0]) throw new AppError('NOT_FOUND', 'Endpoint not found');
          await recordAudit(tx, request, 'endpoint.updated', { type: 'endpoint', id: rows[0].id });
          return rows[0];
        });
        return toView(row);
      },
    );

    app.post(
      '/endpoints/:endpointId/rotate-secret',
      {
        config: { scope: 'endpoints:write' },
        schema: {
          tags: ['endpoints'],
          summary: 'Replace the signing secret. The new secret is returned only once.',
          description:
            'With overlapSeconds > 0 deliveries are signed with both the new and the previous ' +
            'secret until the overlap ends, so receivers can switch without rejecting webhooks. ' +
            'Without it (the default) the previous secret stops being used immediately.',
          params: IdParams,
          body: z
            .object({ overlapSeconds: z.number().int().min(0).max(MAX_OVERLAP_SECONDS).default(0) })
            .strict()
            // A body is optional, as before overlap windows existed.
            .nullish(),
          response: {
            200: z.object({
              id: z.string().uuid(),
              signingSecret: z.string(),
              rotatedAt: z.string(),
              previousSecretExpiresAt: z.string().nullable(),
            }),
          },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const overlapSeconds = request.body?.overlapSeconds ?? 0;
        const signingSecret = generateSigningSecret();
        const sealed = keyring.encrypt(signingSecret);
        const row = await withTransaction(pool, async (tx) => {
          // The right-hand sides see the pre-update row, so the current secret becomes the previous one.
          const { rows } = await tx.query<{
            id: string;
            updated_at: Date;
            previous_secret_expires_at: Date | null;
          }>(
            `UPDATE webhook_endpoints
                SET signing_secret_ciphertext = $3,
                    signing_secret_key_id = $4,
                    previous_signing_secret_ciphertext = CASE WHEN $5 > 0 THEN signing_secret_ciphertext END,
                    previous_signing_secret_key_id = CASE WHEN $5 > 0 THEN signing_secret_key_id END,
                    previous_secret_expires_at = CASE WHEN $5 > 0 THEN now() + make_interval(secs => $5) END,
                    updated_at = now()
              WHERE tenant_id = $1 AND id = $2
          RETURNING id, updated_at, previous_secret_expires_at`,
            [tenantId, request.params.endpointId, sealed.ciphertext, sealed.keyId, overlapSeconds],
          );
          if (!rows[0]) throw new AppError('NOT_FOUND', 'Endpoint not found');
          await recordAudit(tx, request, 'endpoint.secret_rotated', {
            type: 'endpoint',
            id: rows[0].id,
          });
          return rows[0];
        });
        return {
          id: row.id,
          signingSecret,
          rotatedAt: row.updated_at.toISOString(),
          previousSecretExpiresAt: iso(row.previous_secret_expires_at),
        };
      },
    );
  };
}
