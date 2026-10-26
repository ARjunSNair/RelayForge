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
  createdAt: z.string(),
  updatedAt: z.string(),
});

const IdParams = z.object({ endpointId: z.string().uuid() });

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  status: 'active' | 'disabled';
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, url, description, status, created_at, updated_at';

function toView(row: EndpointRow): z.infer<typeof EndpointView> {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function endpointRoutes({ pool, config, secretBox }: AppDeps): FastifyPluginAsyncZod {
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
        const row = await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<EndpointRow>(
            `INSERT INTO webhook_endpoints (tenant_id, url, description, signing_secret_ciphertext)
             VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
            [
              tenantId,
              check.url.toString(),
              request.body.description ?? null,
              secretBox.encrypt(signingSecret),
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
          summary: 'Update description or status. URL changes are not supported in v1.',
          params: IdParams,
          body: z
            .object({
              description: z.string().max(500).nullable().optional(),
              status: z.enum(['active', 'disabled']).optional(),
            })
            .strict(),
          response: { 200: EndpointView },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const { description, status } = request.body;
        const row = await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<EndpointRow>(
            `UPDATE webhook_endpoints
                SET description = CASE WHEN $3 THEN $4 ELSE description END,
                    status = COALESCE($5, status),
                    updated_at = now()
              WHERE tenant_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
            [
              tenantId,
              request.params.endpointId,
              description !== undefined,
              description ?? null,
              status ?? null,
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
          summary: 'Replace the signing secret immediately (no overlap window in v1).',
          params: IdParams,
          response: {
            200: z.object({
              id: z.string().uuid(),
              signingSecret: z.string(),
              rotatedAt: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const { tenantId } = tenantOf(request);
        const signingSecret = generateSigningSecret();
        const row = await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<{ id: string; updated_at: Date }>(
            `UPDATE webhook_endpoints SET signing_secret_ciphertext = $3, updated_at = now()
              WHERE tenant_id = $1 AND id = $2 RETURNING id, updated_at`,
            [tenantId, request.params.endpointId, secretBox.encrypt(signingSecret)],
          );
          if (!rows[0]) throw new AppError('NOT_FOUND', 'Endpoint not found');
          await recordAudit(tx, request, 'endpoint.secret_rotated', {
            type: 'endpoint',
            id: rows[0].id,
          });
          return rows[0];
        });
        return { id: row.id, signingSecret, rotatedAt: row.updated_at.toISOString() };
      },
    );
  };
}
