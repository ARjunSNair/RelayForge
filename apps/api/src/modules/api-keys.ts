import { AppError } from '@relayforge/contracts';
import { withTransaction } from '@relayforge/database';
import { generateApiKey } from '@relayforge/security';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { SCOPES, tenantOf } from '../auth.js';
import type { AppDeps } from '../app.js';

const ApiKeyView = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  /** First characters of the key, for recognising it; the key itself is never stored. */
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

interface ApiKeyRow {
  id: string;
  name: string | null;
  key_prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const COLUMNS = 'id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_at';
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toView(row: ApiKeyRow): z.infer<typeof ApiKeyView> {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: row.scopes,
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: row.created_at.toISOString(),
  };
}

const IdParams = z.object({ apiKeyId: z.string().uuid() });

/** Tenant self-service API keys (design §9.2: creation and revocation are audited). */
export function apiKeyRoutes({ pool }: AppDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/api-keys',
      {
        config: { scope: 'api_keys:manage' },
        schema: {
          tags: ['api-keys'],
          summary: 'Create an API key. The key is returned only once.',
          description:
            'A key can only be granted scopes that the calling key has. ' +
            'Keys are created in the same mode (live or test) as the calling key.',
          body: z
            .object({
              name: z.string().min(1).max(100).optional(),
              scopes: z
                .array(z.enum(SCOPES))
                .min(1)
                .refine((s) => new Set(s).size === s.length, 'must not contain duplicates'),
              expiresAt: z
                .string()
                .datetime({ offset: true })
                .refine((v) => Date.parse(v) > Date.now(), 'must be in the future')
                .optional(),
            })
            .strict(),
          response: { 201: ApiKeyView.extend({ apiKey: z.string() }) },
        },
      },
      async (request, reply) => {
        const auth = tenantOf(request);
        const { name, scopes, expiresAt } = request.body;
        const missing = scopes.filter((s) => !auth.scopes.has(s));
        if (missing.length > 0) {
          throw new AppError(
            'FORBIDDEN',
            `Cannot grant scopes the calling key lacks: ${missing.join(', ')}`,
          );
        }

        const row = await withTransaction(pool, async (tx) => {
          const caller = await tx.query<{ key_prefix: string }>(
            'SELECT key_prefix FROM api_keys WHERE id = $1',
            [auth.apiKeyId],
          );
          const mode = caller.rows[0]?.key_prefix.startsWith('rf_test_') ? 'test' : 'live';
          const { key, hash, prefix } = generateApiKey(mode);
          const { rows } = await tx.query<ApiKeyRow>(
            `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, expires_at, created_by_api_key_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
            [auth.tenantId, name ?? null, prefix, hash, scopes, expiresAt ?? null, auth.apiKeyId],
          );
          const created = rows[0]!;
          await recordAudit(tx, request, 'api_key.created', { type: 'api_key', id: created.id });
          return { ...created, key };
        });
        request.log.info({ operation: 'api_key.create', api_key_id: row.id }, 'api key created');
        return reply.status(201).send({ ...toView(row), apiKey: row.key });
      },
    );

    app.get(
      '/api-keys',
      {
        config: { scope: 'api_keys:manage' },
        schema: {
          tags: ['api-keys'],
          summary: 'List API keys (most recent 100).',
          querystring: z
            .object({ includeRevoked: z.enum(['true', 'false']).default('false') })
            .strict(),
          response: { 200: z.object({ data: z.array(ApiKeyView) }) },
        },
      },
      async (request) => {
        const { rows } = await pool.query<ApiKeyRow>(
          `SELECT ${COLUMNS} FROM api_keys
            WHERE tenant_id = $1 AND ($2 OR revoked_at IS NULL)
            ORDER BY created_at DESC LIMIT 100`,
          [tenantOf(request).tenantId, request.query.includeRevoked === 'true'],
        );
        return { data: rows.map(toView) };
      },
    );

    app.delete(
      '/api-keys/:apiKeyId',
      {
        config: { scope: 'api_keys:manage' },
        schema: {
          tags: ['api-keys'],
          summary: 'Revoke an API key. Takes effect on the next request; idempotent.',
          params: IdParams,
          response: { 200: ApiKeyView },
        },
      },
      async (request) => {
        const auth = tenantOf(request);
        if (request.params.apiKeyId === auth.apiKeyId) {
          throw new AppError(
            'CANNOT_REVOKE_CURRENT_KEY',
            'A key cannot revoke itself; use another key with the api_keys:manage scope',
          );
        }
        const row = await withTransaction(pool, async (tx) => {
          const { rows } = await tx.query<ApiKeyRow & { newly_revoked: boolean }>(
            `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
              WHERE tenant_id = $1 AND id = $2
          RETURNING ${COLUMNS}, revoked_at = now() AS newly_revoked`,
            [auth.tenantId, request.params.apiKeyId],
          );
          const revoked = rows[0];
          if (!revoked) throw new AppError('NOT_FOUND', 'API key not found');
          if (revoked.newly_revoked) {
            await recordAudit(tx, request, 'api_key.revoked', { type: 'api_key', id: revoked.id });
          }
          return revoked;
        });
        return toView(row);
      },
    );
  };
}
