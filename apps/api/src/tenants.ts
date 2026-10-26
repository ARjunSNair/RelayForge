import { withTransaction, type Pool } from '@relayforge/database';
import { generateApiKey, type ApiKeyMode } from '@relayforge/security';
import { SCOPES } from './auth.js';

/**
 * Administrative provisioning (no public API in v1): create a tenant and its
 * first API key. The raw key is returned once and never stored.
 */
export async function createTenantWithApiKey(
  pool: Pool,
  name: string,
  opts: { mode?: ApiKeyMode; scopes?: readonly string[] } = {},
): Promise<{ tenantId: string; apiKeyId: string; apiKey: string }> {
  const { key, hash, prefix } = generateApiKey(opts.mode ?? 'live');
  return withTransaction(pool, async (tx) => {
    const tenant = await tx.query<{ id: string }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    );
    const tenantId = tenant.rows[0]!.id;
    const apiKey = await tx.query<{ id: string }>(
      'INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, prefix, hash, opts.scopes ?? SCOPES],
    );
    return { tenantId, apiKeyId: apiKey.rows[0]!.id, apiKey: key };
  });
}
