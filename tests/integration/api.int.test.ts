import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApi, makeTenant, resetData, secretBox, testPool } from './harness.js';

const pool = testPool();
let api: Awaited<ReturnType<typeof makeApi>>;

beforeAll(async () => {
  api = await makeApi(pool);
});
afterAll(async () => {
  await api.close();
  await pool.end();
});
beforeEach(() => resetData(pool));

async function createEndpoint(headers: Record<string, string>, url = 'http://127.0.0.1:9/hooks') {
  const res = await api.inject({ method: 'POST', url: '/v1/endpoints', headers, payload: { url } });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; signingSecret: string }>();
}

function publish(headers: Record<string, string>, payload: unknown, idempotencyKey?: string) {
  return api.inject({
    method: 'POST',
    url: '/v1/events',
    headers: { ...headers, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    payload: payload as Record<string, unknown>,
  });
}

const count = async (table: string) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await api.inject('/health/live')).statusCode).toBe(200);
    const ready = await api.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ checks: { database: true } });
  });
});

describe('authentication', () => {
  it.each([
    ['missing', {}],
    ['malformed', { authorization: 'Bearer nope' }],
    ['unknown', { authorization: `Bearer rf_test_${'A'.repeat(43)}` }],
  ])('rejects a %s API key with the error envelope', async (_label, headers) => {
    const res = await api.inject({ method: 'GET', url: '/v1/endpoints', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    expect(res.headers['x-request-id']).toBe(res.json().error.requestId);
  });

  it('rejects revoked keys and suspended tenants', async () => {
    const a = await makeTenant(pool);
    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [a.apiKeyId]);
    expect((await api.inject({ url: '/v1/endpoints', headers: a.headers })).statusCode).toBe(401);

    const b = await makeTenant(pool);
    await pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [b.tenantId]);
    expect((await api.inject({ url: '/v1/endpoints', headers: b.headers })).statusCode).toBe(403);
  });

  it('enforces scopes', async () => {
    const t = await makeTenant(pool, 'ReadOnly', ['endpoints:read']);
    expect((await api.inject({ url: '/v1/endpoints', headers: t.headers })).statusCode).toBe(200);
    const res = await api.inject({
      method: 'POST',
      url: '/v1/endpoints',
      headers: t.headers,
      payload: { url: 'https://x.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('endpoints', () => {
  it('returns the signing secret once, stores it encrypted, and never returns it again', async () => {
    const t = await makeTenant(pool);
    const created = await createEndpoint(t.headers);
    expect(created.signingSecret).toMatch(/^whsec_/);

    const stored = await pool.query<{ signing_secret_ciphertext: Buffer }>(
      'SELECT signing_secret_ciphertext FROM webhook_endpoints WHERE id = $1',
      [created.id],
    );
    expect(stored.rows[0]!.signing_secret_ciphertext.toString('utf8')).not.toContain(
      created.signingSecret,
    );
    expect(secretBox.decrypt(stored.rows[0]!.signing_secret_ciphertext)).toBe(
      created.signingSecret,
    );

    const get = await api.inject({ url: `/v1/endpoints/${created.id}`, headers: t.headers });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain('whsec_');
    const list = await api.inject({ url: '/v1/endpoints', headers: t.headers });
    expect(list.body).not.toContain('whsec_');
  });

  it('rotates the secret and records audit events', async () => {
    const t = await makeTenant(pool);
    const created = await createEndpoint(t.headers);
    const res = await api.inject({
      method: 'POST',
      url: `/v1/endpoints/${created.id}/rotate-secret`,
      headers: t.headers,
    });
    expect(res.statusCode).toBe(200);
    const rotated = res.json<{ signingSecret: string }>().signingSecret;
    expect(rotated).not.toBe(created.signingSecret);

    const audit = await pool.query(
      'SELECT action FROM audit_events WHERE tenant_id = $1 ORDER BY created_at',
      [t.tenantId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'endpoint.created',
      'endpoint.secret_rotated',
    ]);
  });

  it('updates status and description but not the URL', async () => {
    const t = await makeTenant(pool);
    const { id } = await createEndpoint(t.headers);
    const patch = await api.inject({
      method: 'PATCH',
      url: `/v1/endpoints/${id}`,
      headers: t.headers,
      payload: { status: 'disabled', description: 'paused' },
    });
    expect(patch.json()).toMatchObject({ status: 'disabled', description: 'paused' });
    const urlChange = await api.inject({
      method: 'PATCH',
      url: `/v1/endpoints/${id}`,
      headers: t.headers,
      payload: { url: 'https://evil.example.com' },
    });
    expect(urlChange.statusCode).toBe(400);
  });

  describe('with strict destination policy', () => {
    let strict: Awaited<ReturnType<typeof makeApi>>;
    beforeAll(async () => {
      strict = await makeApi(pool, { ALLOW_INSECURE_DESTINATIONS: 'false' });
    });
    afterAll(() => strict.close());

    it.each([
      'http://hooks.example.com/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://localhost/x',
      'https://user:pw@hooks.example.com/x',
    ])('rejects %s', async (url) => {
      const t = await makeTenant(pool);
      const res = await strict.inject({
        method: 'POST',
        url: '/v1/endpoints',
        headers: t.headers,
        payload: { url },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('DESTINATION_NOT_ALLOWED');
    });

    it('accepts a public https URL', async () => {
      const t = await makeTenant(pool);
      const res = await strict.inject({
        method: 'POST',
        url: '/v1/endpoints',
        headers: t.headers,
        payload: { url: 'https://hooks.example.com/orders' },
      });
      expect(res.statusCode).toBe(201);
    });
  });
});

describe('event acceptance', () => {
  it('commits event, deliveries and outbox rows before returning 202', async () => {
    const t = await makeTenant(pool);
    const a = await createEndpoint(t.headers);
    const b = await createEndpoint(t.headers);

    const res = await publish(t.headers, {
      type: 'order.created',
      data: { orderId: 'ord_1', amount: 4999 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ eventId: string; status: string; statusUrl: string }>();
    expect(body).toMatchObject({ status: 'accepted', statusUrl: `/v1/events/${body.eventId}` });

    const deliveries = await pool.query(
      'SELECT endpoint_id, status, attempt_count FROM deliveries WHERE event_id = $1',
      [body.eventId],
    );
    expect(deliveries.rows.map((r) => r.endpoint_id).sort()).toEqual([a.id, b.id].sort());
    expect(deliveries.rows.every((r) => r.status === 'queued' && r.attempt_count === 0)).toBe(true);

    const outbox = await pool.query(
      'SELECT message_type, payload FROM outbox_events WHERE event_id = $1',
      [body.eventId],
    );
    expect(outbox.rows).toHaveLength(2);
    expect(outbox.rows[0]).toMatchObject({
      message_type: 'delivery.requested',
      payload: { version: 1, attempt: 1 },
    });

    const get = await api.inject({ url: body.statusUrl, headers: t.headers });
    expect(get.json()).toMatchObject({
      id: body.eventId,
      type: 'order.created',
      data: { orderId: 'ord_1' },
    });
    expect(get.json().deliveries).toHaveLength(2);
  });

  it('targets only the requested endpoints', async () => {
    const t = await makeTenant(pool);
    const a = await createEndpoint(t.headers);
    await createEndpoint(t.headers);
    const res = await publish(t.headers, { type: 'x.y', data: {}, endpointIds: [a.id, a.id] });
    expect(res.statusCode).toBe(202);
    expect(await count('deliveries')).toBe(1);
  });

  describe('idempotency', () => {
    it('returns the original event for a repeated request and creates nothing new', async () => {
      const t = await makeTenant(pool);
      await createEndpoint(t.headers);
      const payload = { type: 'order.created', data: { orderId: 'ord_1', nested: { a: 1, b: 2 } } };
      const first = await publish(t.headers, payload, 'key-1');
      // Same request, different key order: same fingerprint.
      const second = await publish(
        t.headers,
        { data: { nested: { b: 2, a: 1 }, orderId: 'ord_1' }, type: 'order.created' },
        'key-1',
      );
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(await count('events')).toBe(1);
      expect(await count('deliveries')).toBe(1);
      expect(await count('outbox_events')).toBe(1);
    });

    it('returns 409 when a key is reused with a different request', async () => {
      const t = await makeTenant(pool);
      await createEndpoint(t.headers);
      await publish(t.headers, { type: 'order.created', data: { amount: 1 } }, 'key-1');
      const res = await publish(t.headers, { type: 'order.created', data: { amount: 2 } }, 'key-1');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('scopes keys per tenant', async () => {
      const a = await makeTenant(pool, 'A');
      const b = await makeTenant(pool, 'B');
      await createEndpoint(a.headers);
      await createEndpoint(b.headers);
      const ra = await publish(a.headers, { type: 'x', data: { v: 1 } }, 'shared');
      const rb = await publish(b.headers, { type: 'x', data: { v: 2 } }, 'shared');
      expect(rb.statusCode).toBe(202);
      expect(rb.json().eventId).not.toBe(ra.json().eventId);
    });

    it('is safe under concurrent duplicate requests', async () => {
      const t = await makeTenant(pool);
      await createEndpoint(t.headers);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          publish(t.headers, { type: 'order.created', data: { n: 1 } }, 'race'),
        ),
      );
      expect(results.every((r) => r.statusCode === 202)).toBe(true);
      expect(new Set(results.map((r) => r.json().eventId)).size).toBe(1);
      expect(await count('events')).toBe(1);
      expect(await count('outbox_events')).toBe(1);
    });
  });

  it('rolls back everything when an endpoint belongs to another tenant', async () => {
    const a = await makeTenant(pool, 'A');
    const b = await makeTenant(pool, 'B');
    const mine = await createEndpoint(a.headers);
    const theirs = await createEndpoint(b.headers);
    const res = await publish(
      a.headers,
      { type: 'x', data: {}, endpointIds: [mine.id, theirs.id] },
      'k',
    );
    expect(res.statusCode).toBe(404);
    expect(await count('events')).toBe(0);
    expect(await count('deliveries')).toBe(0);
    expect(await count('outbox_events')).toBe(0);
  });

  it('rejects disabled endpoints and tenants without endpoints', async () => {
    const t = await makeTenant(pool);
    expect((await publish(t.headers, { type: 'x', data: {} })).json().error.code).toBe(
      'NO_ACTIVE_ENDPOINTS',
    );
    const { id } = await createEndpoint(t.headers);
    await api.inject({
      method: 'PATCH',
      url: `/v1/endpoints/${id}`,
      headers: t.headers,
      payload: { status: 'disabled' },
    });
    const res = await publish(t.headers, { type: 'x', data: {}, endpointIds: [id] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ENDPOINT_DISABLED');
  });

  it.each([
    ['missing type', { data: {} }],
    ['bad type', { type: 'has space', data: {} }],
    ['non-object data', { type: 'x', data: [1, 2] }],
    ['unknown field', { type: 'x', data: {}, tenantId: '00000000-0000-0000-0000-000000000000' }],
    ['bad endpoint id', { type: 'x', data: {}, endpointIds: ['nope'] }],
  ])('rejects %s with 400', async (_label, payload) => {
    const t = await makeTenant(pool);
    await createEndpoint(t.headers);
    const res = await publish(t.headers, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects deeply nested payloads', async () => {
    const t = await makeTenant(pool);
    await createEndpoint(t.headers);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect((await publish(t.headers, { type: 'x', data: deep })).statusCode).toBe(400);
  });

  it('enforces the payload size limit', async () => {
    const small = await makeApi(pool, { MAX_EVENT_PAYLOAD_BYTES: '1024' });
    try {
      const t = await makeTenant(pool);
      const { id } = await createEndpoint(t.headers);
      const ok = await small.inject({
        method: 'POST',
        url: '/v1/events',
        headers: t.headers,
        payload: { type: 'x', data: { s: 'a'.repeat(900) }, endpointIds: [id] },
      });
      expect(ok.statusCode).toBe(202);
      const tooBig = await small.inject({
        method: 'POST',
        url: '/v1/events',
        headers: t.headers,
        payload: { type: 'x', data: { s: 'a'.repeat(2000) } },
      });
      expect(tooBig.statusCode).toBe(413);
      const wayTooBig = await small.inject({
        method: 'POST',
        url: '/v1/events',
        headers: t.headers,
        payload: { type: 'x', data: { s: 'a'.repeat(100_000) } },
      });
      expect(wayTooBig.statusCode).toBe(413);
      expect(wayTooBig.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      await small.close();
    }
  });
});

describe('tenant isolation', () => {
  it('hides every resource of another tenant', async () => {
    const a = await makeTenant(pool, 'A');
    const b = await makeTenant(pool, 'B');
    const endpoint = await createEndpoint(a.headers);
    const event = (await publish(a.headers, { type: 'x', data: {} })).json<{ eventId: string }>();
    const delivery = (await pool.query<{ id: string }>('SELECT id FROM deliveries')).rows[0]!;
    await pool.query(`UPDATE deliveries SET status = 'dead_lettered'`);

    const attempts = [
      api.inject({ url: `/v1/endpoints/${endpoint.id}`, headers: b.headers }),
      api.inject({
        method: 'PATCH',
        url: `/v1/endpoints/${endpoint.id}`,
        headers: b.headers,
        payload: { status: 'disabled' },
      }),
      api.inject({
        method: 'POST',
        url: `/v1/endpoints/${endpoint.id}/rotate-secret`,
        headers: b.headers,
      }),
      api.inject({ url: `/v1/events/${event.eventId}`, headers: b.headers }),
      api.inject({ url: `/v1/deliveries/${delivery.id}`, headers: b.headers }),
      api.inject({
        method: 'POST',
        url: `/v1/deliveries/${delivery.id}/replay`,
        headers: b.headers,
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(404);

    expect((await api.inject({ url: '/v1/endpoints', headers: b.headers })).json().data).toEqual(
      [],
    );
    expect((await api.inject({ url: '/v1/deliveries', headers: b.headers })).json().data).toEqual(
      [],
    );
    const unchanged = await pool.query('SELECT status FROM webhook_endpoints WHERE id = $1', [
      endpoint.id,
    ]);
    expect(unchanged.rows[0]!.status).toBe('active');
  });
});

describe('delivery search', () => {
  it('paginates with a stable cursor and filters by status', async () => {
    const t = await makeTenant(pool);
    await createEndpoint(t.headers);
    for (let i = 0; i < 7; i++) await publish(t.headers, { type: 'x', data: { i } });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await api.inject({
        url: `/v1/deliveries?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        headers: t.headers,
      });
      expect(res.statusCode).toBe(200);
      const page = res.json<{ data: { id: string }[]; nextCursor: string | null }>();
      expect(page.data.length).toBeLessThanOrEqual(3);
      seen.push(...page.data.map((d) => d.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);

    const queued = await api.inject({ url: '/v1/deliveries?status=queued', headers: t.headers });
    expect(queued.json().data).toHaveLength(7);
    const none = await api.inject({ url: '/v1/deliveries?status=succeeded', headers: t.headers });
    expect(none.json().data).toHaveLength(0);
  });

  it('enforces the maximum page size and rejects bad cursors', async () => {
    const t = await makeTenant(pool);
    expect(
      (await api.inject({ url: '/v1/deliveries?limit=101', headers: t.headers })).statusCode,
    ).toBe(400);
    expect(
      (await api.inject({ url: '/v1/deliveries?cursor=garbage', headers: t.headers })).statusCode,
    ).toBe(400);
  });
});

describe('rate limiting', () => {
  it('limits per tenant', async () => {
    const limited = await makeApi(pool, { RATE_LIMIT_MAX: '2' });
    try {
      const a = await makeTenant(pool, 'A');
      const b = await makeTenant(pool, 'B');
      const codes = [];
      for (let i = 0; i < 3; i++)
        codes.push((await limited.inject({ url: '/v1/endpoints', headers: a.headers })).statusCode);
      expect(codes).toEqual([200, 200, 429]);
      expect((await limited.inject({ url: '/v1/endpoints', headers: b.headers })).statusCode).toBe(
        200,
      );
    } finally {
      await limited.close();
    }
  });
});
