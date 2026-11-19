import type { Pool } from '@relayforge/database';
import { describe, expect, it, vi } from 'vitest';
import { createApiKey, createTenantWithApiKey } from './tenants.js';

// Scope validation runs before any query, so a pool that must never be touched is enough.
function untouchedPool() {
  const connect = vi.fn();
  const query = vi.fn();
  return { pool: { connect, query } as unknown as Pool, connect, query };
}

describe('administrative provisioning scope validation', () => {
  it('rejects unknown scopes when creating a tenant, before touching the database', async () => {
    const { pool, connect, query } = untouchedPool();
    await expect(
      createTenantWithApiKey(pool, 'acme', { scopes: ['events:write', 'nope'] }),
    ).rejects.toThrow('Unknown scopes: nope');
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unknown scopes when creating a key for an existing tenant', async () => {
    const { pool, query } = untouchedPool();
    await expect(createApiKey(pool, 'tenant-id', { scopes: ['a', 'b'] })).rejects.toThrow(
      'Unknown scopes: a, b',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
