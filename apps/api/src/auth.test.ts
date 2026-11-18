import type { Pool } from '@relayforge/database';
import { generateApiKey } from '@relayforge/security';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractBearerToken, registerAuthentication, tenantOf } from './auth.js';
import { registerErrorHandling } from './errors.js';

describe('extractBearerToken', () => {
  it('extracts the token and accepts any case for the scheme', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER   abc  ')).toBe('abc');
  });

  it('rejects missing, empty and non-bearer credentials', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer a b')).toBeUndefined();
  });
});

describe('registerAuthentication', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  type KeyRow = { id: string; tenant_id: string; scopes: string[]; tenant_status: string };

  /** A fake pool: the first query is the key lookup, later ones the last_used_at touch. */
  function build(row: KeyRow | undefined, touch: () => Promise<unknown> = async () => ({})) {
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT') ? { rows: row ? [row] : [] } : touch(),
    );
    const app = Fastify({ logger: false });
    registerErrorHandling(app);
    registerAuthentication(app, { query } as unknown as Pool);
    app.get(
      '/read',
      { config: { scope: 'events:read' } },
      async (request) => tenantOf(request).tenantId,
    );
    apps.push(app);
    return { app, query };
  }

  const active: KeyRow = {
    id: 'k1',
    tenant_id: 't1',
    scopes: ['events:read'],
    tenant_status: 'active',
  };
  const bearer = () => ({ authorization: `Bearer ${generateApiKey().key}` });

  it('rejects malformed keys without querying the database', async () => {
    const { app, query } = build(active);
    const res = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects well-formed keys that match no live key', async () => {
    const res = await build(undefined).app.inject({
      method: 'GET',
      url: '/read',
      headers: bearer(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects keys of a suspended tenant', async () => {
    const { app } = build({ ...active, tenant_status: 'suspended' });
    const res = await app.inject({ method: 'GET', url: '/read', headers: bearer() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Tenant is suspended');
  });

  it('requires the route scope', async () => {
    const { app } = build({ ...active, scopes: ['endpoints:read'] });
    const res = await app.inject({ method: 'GET', url: '/read', headers: bearer() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('API key lacks the events:read scope');
  });

  it('derives the tenant from the key and ignores a failing last_used_at update', async () => {
    const { app, query } = build(active, async () => {
      throw new Error('db down');
    });
    const res = await app.inject({ method: 'GET', url: '/read', headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('t1');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
