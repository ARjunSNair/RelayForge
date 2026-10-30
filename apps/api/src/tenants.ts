import { withTransaction, type Pool } from '@relayforge/database';
import { generateApiKey, type ApiKeyMode } from '@relayforge/security';
import { SCOPES } from './auth.js';

/**
 * Administrative provisioning: create a tenant and its first API key, which
 * holds every scope (including api_keys:manage for issuing further keys).
 * The raw key is returned once and never stored.
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

/** Administrative key issuance for an existing tenant (e.g. one created before key management existed). */
export async function createApiKey(
  pool: Pool,
  tenantId: string,
  opts: { mode?: ApiKeyMode; scopes?: readonly string[]; name?: string } = {},
): Promise<{ apiKeyId: string; apiKey: string; scopes: readonly string[] }> {
  const scopes = opts.scopes ?? SCOPES;
  const unknown = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`Unknown scopes: ${unknown.join(', ')}`);
  const { key, hash, prefix } = generateApiKey(opts.mode ?? 'live');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, opts.name ?? null, prefix, hash, scopes],
  );
  return { apiKeyId: rows[0]!.id, apiKey: key, scopes };
}
