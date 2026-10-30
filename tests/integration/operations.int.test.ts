import { randomBytes } from 'node:crypto';
import { SecretKeyring, verifySignature } from '@relayforge/security';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rewrapSigningSecrets } from '../../apps/api/src/key-rotation.js';
import { runRetention } from '../../apps/outbox-publisher/src/retention.js';
import { enqueueDueRetries } from '../../apps/outbox-publisher/src/retry-scheduler.js';
import {
  ENCRYPTION_KEY,
  keyring,
  makeApi,
  makePipeline,
  makeRetriesDue,
  makeTenant,
  Receiver,
  resetData,
  testPool,
} from './harness.js';

const pool = testPool();
let api: Awaited<ReturnType<typeof makeApi>>;
let receiver: Receiver;

beforeAll(async () => {
  api = await makeApi(pool);
  receiver = await Receiver.start();
});
afterAll(async () => {
  await receiver.stop();
  await api.close();
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  receiver.reset();
});

type Tenant = Awaited<ReturnType<typeof makeTenant>>;

async function createEndpoint(t: Tenant, body: Record<string, unknown> = {}) {
  const res = await api.inject({
    method: 'POST',
    url: '/v1/endpoints',
    headers: t.headers,
    payload: { url: receiver.url, ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; signingSecret: string }>();
}

async function publish(t: Tenant, extraHeaders: Record<string, string> = {}) {
  const res = await api.inject({
    method: 'POST',
    url: '/v1/events',
    headers: { ...t.headers, ...extraHeaders },
    payload: { type: 'order.created', data: { orderId: randomBytes(4).toString('hex') } },
  });
  expect(res.statusCode).toBe(202);
  return res;
}

async function deliveryRows() {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    attempt_count: number;
    next_attempt_at: Date | null;
  }>('SELECT id, status, attempt_count, next_attempt_at FROM deliveries ORDER BY created_at, id');
  return rows;
}

async function attemptCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM delivery_attempts',
  );
  return rows[0]!.n;
}

/** Requeue deferred/retrying deliveries and process everything until idle. */
async function drain(pipeline: ReturnType<typeof makePipeline>, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await makeRetriesDue(pool);
    await enqueueDueRetries(pool, 100);
    if ((await pipeline.pump()) === 0) return;
  }
}

describe('API key management', () => {
  it('creates, lists and revokes keys, with audit records', async () => {
    const t = await makeTenant(pool);
    const created = await api.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: t.headers,
      payload: { name: 'CI publisher', scopes: ['events:write'] },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ id: string; apiKey: string; prefix: string; scopes: string[] }>();
    // Same mode as the calling (test) key; only a prefix is ever shown again.
    expect(key.apiKey).toMatch(/^rf_test_/);
    expect(key.apiKey.startsWith(key.prefix)).toBe(true);
    expect(key.scopes).toEqual(['events:write']);

    const headers = { authorization: `Bearer ${key.apiKey}` };
    await createEndpoint(t);
    expect((await publish({ ...t, headers })).statusCode).toBe(202);
    const denied = await api.inject({ url: '/v1/endpoints', headers });
    expect(denied.statusCode).toBe(403);

    const list = await api.inject({ url: '/v1/api-keys', headers: t.headers });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(key.apiKey);
    expect(list.json<{ data: { id: string }[] }>().data.map((k) => k.id)).toContain(key.id);

    const revoke = () =>
      api.inject({ method: 'DELETE', url: `/v1/api-keys/${key.id}`, headers: t.headers });
    const revoked = await revoke();
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<{ revokedAt: string | null }>().revokedAt).not.toBeNull();
    expect((await revoke()).statusCode).toBe(200);

    const after = await api.inject({
      url: '/v1/events/00000000-0000-4000-8000-000000000000',
      headers,
    });
    expect(after.statusCode).toBe(401);
    const active = await api.inject({ url: '/v1/api-keys', headers: t.headers });
    expect(active.json<{ data: { id: string }[] }>().data.map((k) => k.id)).not.toContain(key.id);
    const all = await api.inject({ url: '/v1/api-keys?includeRevoked=true', headers: t.headers });
    expect(all.json<{ data: { id: string }[] }>().data.map((k) => k.id)).toContain(key.id);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_id = $1 ORDER BY created_at`,
      [key.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['api_key.created', 'api_key.revoked']);
  });

  it('refuses scope escalation, self-revocation and keys without the scope', async () => {
    const t = await makeTenant(pool);
    const limited = await makeTenant(pool, 'Limited', ['api_keys:manage', 'events:read']);

    const escalate = await api.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: limited.headers,
      payload: { scopes: ['events:write'] },
    });
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

    const self = await api.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${t.apiKeyId}`,
      headers: t.headers,
    });
    expect(self.statusCode).toBe(409);
    expect(self.json<{ error: { code: string } }>().error.code).toBe('CANNOT_REVOKE_CURRENT_KEY');

    const noScope = await makeTenant(pool, 'NoScope', ['events:read']);
    const res = await api.inject({ url: '/v1/api-keys', headers: noScope.headers });
    expect(res.statusCode).toBe(403);

    const past = await api.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: t.headers,
      payload: { scopes: ['events:read'], expiresAt: '2001-01-01T00:00:00Z' },
    });
    expect(past.statusCode).toBe(400);
  });

  it('cannot see or revoke another tenant’s keys', async () => {
    const a = await makeTenant(pool, 'A');
    const b = await makeTenant(pool, 'B');
    const res = await api.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${a.apiKeyId}`,
      headers: b.headers,
    });
    expect(res.statusCode).toBe(404);
    const list = await api.inject({ url: '/v1/api-keys', headers: b.headers });
    expect(list.body).not.toContain(a.apiKeyId);
  });
});

describe('signing secret rotation', () => {
  it('signs with both secrets during the overlap window, then only the new one', async () => {
    const pipeline = makePipeline(pool);
    try {
      const t = await makeTenant(pool);
      const endpoint = await createEndpoint(t);
      const rotate = (payload?: object) =>
        api.inject({
          method: 'POST',
          url: `/v1/endpoints/${endpoint.id}/rotate-secret`,
          headers: t.headers,
          ...(payload ? { payload } : {}),
        });

      const rotated = await rotate({ overlapSeconds: 3600 });
      expect(rotated.statusCode).toBe(200);
      const { signingSecret, previousSecretExpiresAt } = rotated.json<{
        signingSecret: string;
        previousSecretExpiresAt: string | null;
      }>();
      expect(Date.parse(previousSecretExpiresAt!)).toBeGreaterThan(Date.now() + 3_500_000);

      await publish(t);
      await pipeline.pump();
      const req = receiver.requests[0]!;
      const header = String(req.headers['relayforge-signature']);
      expect(header.split(',')).toHaveLength(2);
      for (const secret of [signingSecret, endpoint.signingSecret]) {
        const result = verifySignature({
          secret,
          rawBody: req.body,
          signatureHeader: header,
          timestampHeader: String(req.headers['relayforge-timestamp']),
        });
        expect(result.ok).toBe(true);
      }

      // Rotating without an overlap drops the previous secret immediately.
      const again = await rotate();
      expect(
        again.json<{ previousSecretExpiresAt: string | null }>().previousSecretExpiresAt,
      ).toBeNull();
      receiver.reset();
      await publish(t);
      await pipeline.pump();
      expect(String(receiver.requests[0]!.headers['relayforge-signature']).split(',')).toHaveLength(
        1,
      );
    } finally {
      await pipeline.close();
    }
  });

  it('stops using the previous secret once the overlap expires', async () => {
    const pipeline = makePipeline(pool);
    try {
      const t = await makeTenant(pool);
      const endpoint = await createEndpoint(t);
      await api.inject({
        method: 'POST',
        url: `/v1/endpoints/${endpoint.id}/rotate-secret`,
        headers: t.headers,
        payload: { overlapSeconds: 60 },
      });
      await pool.query(
        `UPDATE webhook_endpoints SET previous_secret_expires_at = now() - interval '1 second' WHERE id = $1`,
        [endpoint.id],
      );
      await publish(t);
      await pipeline.pump();
      expect(String(receiver.requests[0]!.headers['relayforge-signature']).split(',')).toHaveLength(
        1,
      );
    } finally {
      await pipeline.close();
    }
  });

  it('rejects overlap windows longer than seven days', async () => {
    const t = await makeTenant(pool);
    const endpoint = await createEndpoint(t);
    const res = await api.inject({
      method: 'POST',
      url: `/v1/endpoints/${endpoint.id}/rotate-secret`,
      headers: t.headers,
      payload: { overlapSeconds: 8 * 24 * 3600 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('encryption key rotation', () => {
  it('rewraps secrets under a new primary key without changing them', async () => {
    const t = await makeTenant(pool);
    const endpoint = await createEndpoint(t);
    await api.inject({
      method: 'POST',
      url: `/v1/endpoints/${endpoint.id}/rotate-secret`,
      headers: t.headers,
      payload: { overlapSeconds: 600 },
    });

    const k2 = randomBytes(32).toString('base64');
    const rotatedRing = new SecretKeyring('k2', k2, [{ id: 'k1', key: ENCRYPTION_KEY }]);
    expect(await rewrapSigningSecrets(pool, rotatedRing, 1)).toEqual({
      rewrapped: 1,
      remaining: 0,
    });
    expect(await rewrapSigningSecrets(pool, rotatedRing)).toEqual({ rewrapped: 0, remaining: 0 });

    const { rows } = await pool.query<{
      signing_secret_key_id: string;
      signing_secret_ciphertext: Buffer;
      previous_signing_secret_key_id: string;
      previous_signing_secret_ciphertext: Buffer;
    }>('SELECT * FROM webhook_endpoints WHERE id = $1', [endpoint.id]);
    const row = rows[0]!;
    expect(row.signing_secret_key_id).toBe('k2');
    expect(row.previous_signing_secret_key_id).toBe('k2');
    // k1 is no longer needed.
    const onlyK2 = new SecretKeyring('k2', k2);
    expect(
      onlyK2.decrypt({
        keyId: row.previous_signing_secret_key_id,
        ciphertext: row.previous_signing_secret_ciphertext,
      }),
    ).toBe(endpoint.signingSecret);
    expect(() =>
      keyring.decrypt({
        keyId: row.signing_secret_key_id,
        ciphertext: row.signing_secret_ciphertext,
      }),
    ).toThrow(/Unknown encryption key id/);
  });
});

describe('delivery fairness', () => {
  it('caps concurrent attempts per endpoint without using up attempts', async () => {
    const pipeline = makePipeline(pool);
    try {
      const t = await makeTenant(pool);
      await createEndpoint(t, { maxConcurrency: 1 });
      receiver.always({ status: 200, delayMs: 200 });
      for (let i = 0; i < 3; i++) await publish(t);

      await pipeline.pump();
      expect(receiver.requests).toHaveLength(1);
      const first = await deliveryRows();
      expect(first.filter((d) => d.status === 'succeeded')).toHaveLength(1);
      const deferred = first.filter((d) => d.status === 'retry_scheduled');
      expect(deferred).toHaveLength(2);
      expect(deferred.every((d) => d.attempt_count === 0)).toBe(true);

      await drain(pipeline);
      const done = await deliveryRows();
      expect(done.every((d) => d.status === 'succeeded' && d.attempt_count === 1)).toBe(true);
      expect(await attemptCount()).toBe(3);
    } finally {
      await pipeline.close();
    }
  });

  it('caps concurrent attempts per tenant across endpoints', async () => {
    const pipeline = makePipeline(pool, { fairness: { tenantMaxConcurrency: 1 } });
    try {
      const t = await makeTenant(pool);
      await createEndpoint(t);
      await createEndpoint(t);
      receiver.always({ status: 200, delayMs: 200 });
      await publish(t); // fans out to both endpoints

      await pipeline.pump();
      expect(receiver.requests).toHaveLength(1);
      await drain(pipeline);
      expect((await deliveryRows()).every((d) => d.status === 'succeeded')).toBe(true);
    } finally {
      await pipeline.close();
    }
  });

  it('suspends an endpoint after consecutive failures and resumes on re-activation', async () => {
    const pipeline = makePipeline(pool, {
      maxAttempts: 5,
      fairness: { failureThreshold: 2, suspensionMs: 60_000 },
    });
    try {
      const t = await makeTenant(pool);
      const endpoint = await createEndpoint(t);
      receiver.always({ status: 503 });
      await publish(t);
      await pipeline.pump();
      await makeRetriesDue(pool);
      await enqueueDueRetries(pool, 100);
      await pipeline.pump();
      expect(receiver.requests).toHaveLength(2);

      const view = await api.inject({ url: `/v1/endpoints/${endpoint.id}`, headers: t.headers });
      const health = view.json<{
        health: { consecutiveFailures: number; suppressedUntil: string | null };
      }>().health;
      expect(health.consecutiveFailures).toBe(2);
      expect(Date.parse(health.suppressedUntil!)).toBeGreaterThan(Date.now() + 50_000);

      // While suspended, new deliveries wait for the suspension without an attempt.
      await publish(t);
      await pipeline.pump();
      expect(receiver.requests).toHaveLength(2);
      const waiting = (await deliveryRows())[1]!;
      expect(waiting.status).toBe('retry_scheduled');
      expect(waiting.attempt_count).toBe(0);
      expect(waiting.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(
        Date.parse(health.suppressedUntil!),
      );

      // Re-activating clears the breaker; a success keeps it closed.
      const patched = await api.inject({
        method: 'PATCH',
        url: `/v1/endpoints/${endpoint.id}`,
        headers: t.headers,
        payload: { status: 'active' },
      });
      expect(patched.json<{ health: { suppressedUntil: string | null } }>().health).toEqual({
        consecutiveFailures: 0,
        suppressedUntil: null,
      });
      receiver.always({ status: 200 });
      await drain(pipeline);
      expect((await deliveryRows()).every((d) => d.status === 'succeeded')).toBe(true);
    } finally {
      await pipeline.close();
    }
  });

  it('lets one probe through at a time after a suspension ends (half-open)', async () => {
    const pipeline = makePipeline(pool, { fairness: { failureThreshold: 2 } });
    try {
      const t = await makeTenant(pool);
      const endpoint = await createEndpoint(t, { maxConcurrency: 10 });
      await pool.query(
        `UPDATE webhook_endpoints
            SET consecutive_failures = 5, suppressed_until = now() - interval '1 second'
          WHERE id = $1`,
        [endpoint.id],
      );
      receiver.always({ status: 200, delayMs: 200 });
      for (let i = 0; i < 3; i++) await publish(t);
      await pipeline.pump();
      expect(receiver.requests).toHaveLength(1);

      const { rows } = await pool.query<{ consecutive_failures: number }>(
        'SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1',
        [endpoint.id],
      );
      expect(rows[0]!.consecutive_failures).toBe(0);
      await drain(pipeline);
      expect(receiver.requests).toHaveLength(3);
    } finally {
      await pipeline.close();
    }
  });

  it('does not count permanent failures towards suspension', async () => {
    const pipeline = makePipeline(pool, { fairness: { failureThreshold: 1 } });
    try {
      const t = await makeTenant(pool);
      const endpoint = await createEndpoint(t);
      receiver.always({ status: 400 });
      await publish(t);
      await pipeline.pump();
      const { rows } = await pool.query<{
        consecutive_failures: number;
        suppressed_until: Date | null;
      }>('SELECT consecutive_failures, suppressed_until FROM webhook_endpoints WHERE id = $1', [
        endpoint.id,
      ]);
      expect(rows[0]).toEqual({ consecutive_failures: 0, suppressed_until: null });
    } finally {
      await pipeline.close();
    }
  });
});

describe('trace propagation', () => {
  const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

  it('carries the caller’s trace from the API to the destination and attempt record', async () => {
    const pipeline = makePipeline(pool, { maxAttempts: 3 });
    try {
      const t = await makeTenant(pool);
      await createEndpoint(t);
      receiver.reply({ status: 500 });
      const res = await publish(t, { traceparent: incoming });
      expect(String(res.headers['traceparent'])).toContain(traceId);
      expect(String(res.headers['traceparent'])).not.toBe(incoming);

      await pipeline.pump();
      // The retry is re-sent by the scheduler and stays in the same trace.
      await makeRetriesDue(pool);
      await enqueueDueRetries(pool, 100);
      await pipeline.pump();
      expect(receiver.requests).toHaveLength(2);
      for (const req of receiver.requests) {
        expect(String(req.headers['traceparent'])).toMatch(
          new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
        );
      }

      const deliveryId = (await deliveryRows())[0]!.id;
      const view = await api.inject({ url: `/v1/deliveries/${deliveryId}`, headers: t.headers });
      const attempts = view.json<{ attempts: { traceId: string }[] }>().attempts;
      expect(attempts.map((a) => a.traceId)).toEqual([traceId, traceId]);
    } finally {
      await pipeline.close();
    }
  });

  it('starts a new trace when the caller sends none (or an invalid one)', async () => {
    const t = await makeTenant(pool);
    await createEndpoint(t);
    const res = await publish(t, { traceparent: 'not-a-trace' });
    expect(String(res.headers['traceparent'])).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const { rows } = await pool.query<{ traceparent: string }>(
      'SELECT traceparent FROM outbox_events',
    );
    expect(rows[0]!.traceparent).toBe(res.headers['traceparent']);
  });
});

describe('metrics', () => {
  it('serves Prometheus metrics only with the metrics token', async () => {
    const token = 'metrics-token-0123456789';
    const app = await makeApi(pool, { METRICS_TOKEN: token });
    try {
      const t = await makeTenant(pool);
      await createEndpoint(t);
      await publish(t);
      expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } }))
          .statusCode,
      ).toBe(401);
      const res = await app.inject({
        url: '/metrics',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('events_accepted_total');
      expect(res.body).toMatch(
        /api_requests_total\{route="\/v1\/events",method="POST",status_class="2xx"\}/,
      );
      // Never tenant ids or URLs as labels.
      expect(res.body).not.toContain(t.tenantId);
      expect(res.body).not.toContain('127.0.0.1');
    } finally {
      await app.close();
    }
    // Without a configured token the endpoint does not exist.
    expect((await api.inject({ url: '/metrics' })).statusCode).toBe(404);
  });
});

describe('distributed rate limiting', () => {
  it('shares one tenant budget across API replicas', async () => {
    const settings = {
      RATE_LIMIT_STORE: 'postgres',
      RATE_LIMIT_MAX: '3',
      RATE_LIMIT_WINDOW_MS: '60000',
    };
    const replicaA = await makeApi(pool, settings);
    const replicaB = await makeApi(pool, settings);
    try {
      const t = await makeTenant(pool);
      const statuses: number[] = [];
      for (const replica of [replicaA, replicaB, replicaA, replicaB]) {
        statuses.push(
          (await replica.inject({ url: '/v1/endpoints', headers: t.headers })).statusCode,
        );
      }
      expect(statuses).toEqual([200, 200, 200, 429]);

      // Another tenant has its own budget.
      const other = await makeTenant(pool, 'Other');
      expect(
        (await replicaB.inject({ url: '/v1/endpoints', headers: other.headers })).statusCode,
      ).toBe(200);
    } finally {
      await replicaA.close();
      await replicaB.close();
    }
  });
});

describe('retention', () => {
  const policy = { eventDays: 30, outboxHours: 24, queueDeadLetterDays: 14, batchSize: 100 };

  it('removes old finished events with their history and keeps active ones', async () => {
    const pipeline = makePipeline(pool);
    try {
      const t = await makeTenant(pool);
      await createEndpoint(t);
      const done = (await publish(t)).json<{ eventId: string }>().eventId;
      await pipeline.pump();
      const replayable = (await publish(t)).json<{ eventId: string }>().eventId; // still queued
      const recent = (await publish(t)).json<{ eventId: string }>().eventId;
      await pool.query(
        `UPDATE events SET created_at = now() - interval '40 days' WHERE id = ANY($1::uuid[])`,
        [[done, replayable]],
      );
      await pool.query(
        `UPDATE outbox_events SET published_at = now() - interval '2 days' WHERE published_at IS NOT NULL`,
      );
      await pool.query(
        `INSERT INTO rate_limit_counters (key, window_start, count, expires_at)
         VALUES ('tenant:old', now() - interval '2 hours', 1, now() - interval '1 hour')`,
      );

      const counts = await runRetention(pool, policy);
      expect(counts).toMatchObject({
        events: 1,
        deliveries: 1,
        delivery_attempts: 1,
        rate_limit_counters: 1,
      });
      expect(counts.outbox_events).toBeGreaterThanOrEqual(1);

      const { rows } = await pool.query<{ id: string }>('SELECT id FROM events');
      expect(rows.map((r) => r.id).sort()).toEqual([replayable, recent].sort());
      expect(await runRetention(pool, policy)).toMatchObject({ events: 0, deliveries: 0 });
    } finally {
      await pipeline.close();
    }
  });
});
