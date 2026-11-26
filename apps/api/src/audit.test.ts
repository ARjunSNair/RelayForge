import type { Queryable } from '@relayforge/database';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { recordAudit } from './audit.js';

function fakeDb() {
  const query = vi.fn(async () => ({ rows: [] }));
  return { db: { query } as unknown as Queryable, query };
}

describe('recordAudit', () => {
  it('inserts the actor, action, resource and request id', async () => {
    const { db, query } = fakeDb();
    const request = {
      id: 'req-1',
      auth: { tenantId: 'tenant-1', apiKeyId: 'key-1', scopes: new Set<string>() },
    } as unknown as FastifyRequest;

    await recordAudit(db, request, 'endpoint.created', { type: 'endpoint', id: 'ep-1' });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO audit_events');
    expect(params).toEqual(['tenant-1', 'key-1', 'endpoint.created', 'endpoint', 'ep-1', 'req-1']);
  });

  it('refuses to write an audit row for an unauthenticated request', async () => {
    const { db, query } = fakeDb();
    const request = { id: 'req-2', auth: null } as unknown as FastifyRequest;

    await expect(
      recordAudit(db, request, 'api_key.revoked', { type: 'api_key', id: 'k' }),
    ).rejects.toThrow(/Authentication required/);
    expect(query).not.toHaveBeenCalled();
  });
});
