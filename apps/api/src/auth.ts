import { AppError } from '@relayforge/contracts';
import type { Pool } from '@relayforge/database';
import { hashApiKey, isWellFormedApiKey } from '@relayforge/security';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const SCOPES = [
  'endpoints:read',
  'endpoints:write',
  'events:read',
  'events:write',
  'deliveries:read',
  'deliveries:replay',
] as const;
export type Scope = (typeof SCOPES)[number];

export interface AuthContext {
  tenantId: string;
  apiKeyId: string;
  scopes: ReadonlySet<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    /** Scope an API key needs to call the route. */
    scope?: Scope;
  }
}

/** Returns the authenticated context, which every /v1 route is guaranteed to have. */
export function tenantOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return request.auth;
}

/**
 * Bearer API-key authentication for the encapsulated /v1 scope. The tenant is
 * derived from the credential only, never from the request (design §9.3).
 * Runs on onRequest so tenant-keyed rate limiting can use it.
 */
export function registerAuthentication(app: FastifyInstance, pool: Pool): void {
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!key || !isWellFormedApiKey(key)) {
      throw new AppError('UNAUTHENTICATED', 'A valid API key is required');
    }

    const { rows } = await pool.query<{
      id: string;
      tenant_id: string;
      scopes: string[];
      tenant_status: string;
    }>(
      `SELECT k.id, k.tenant_id, k.scopes, t.status AS tenant_status
         FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())`,
      [hashApiKey(key)],
    );
    const row = rows[0];
    if (!row) throw new AppError('UNAUTHENTICATED', 'A valid API key is required');
    if (row.tenant_status !== 'active') throw new AppError('FORBIDDEN', 'Tenant is suspended');

    const required = request.routeOptions.config.scope;
    if (required && !row.scopes.includes(required)) {
      throw new AppError('FORBIDDEN', `API key lacks the ${required} scope`);
    }

    request.auth = { tenantId: row.tenant_id, apiKeyId: row.id, scopes: new Set(row.scopes) };
    request.log = request.log.child({ tenant_id: row.tenant_id });

    // Best effort, throttled to one write per key per minute.
    pool
      .query(
        `UPDATE api_keys SET last_used_at = now()
          WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [row.id],
      )
      .catch(() => undefined);
  });
}
