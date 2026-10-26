import { verifySignature } from '@relayforge/security';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookHttpClient } from '../../apps/delivery-worker/src/http-client.js';
import {
  recoverStalledDeliveries,
  enqueueDueRetries,
} from '../../apps/outbox-publisher/src/retry-scheduler.js';
import {
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
let pipeline: ReturnType<typeof makePipeline>;

beforeAll(async () => {
  api = await makeApi(pool);
  receiver = await Receiver.start();
  pipeline = makePipeline(pool);
});
afterAll(async () => {
  await pipeline.close();
  await receiver.stop();
  await api.close();
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  receiver.reset();
});

async function setup(url = receiver.url) {
  const tenant = await makeTenant(pool);
  const endpoint = (
    await api.inject({
      method: 'POST',
      url: '/v1/endpoints',
      headers: tenant.headers,
      payload: { url },
    })
  ).json<{ id: string; signingSecret: string }>();
  const event = (
    await api.inject({
      method: 'POST',
      url: '/v1/events',
      headers: tenant.headers,
      payload: {
        type: 'order.created',
        data: { orderId: 'ord_demo_123', amount: 4999, currency: 'EUR' },
      },
    })
  ).json<{ eventId: string }>();
  const deliveryId = (
    await pool.query<{ id: string }>('SELECT id FROM deliveries WHERE event_id = $1', [
      event.eventId,
    ])
  ).rows[0]!.id;
  return { tenant, endpoint, eventId: event.eventId, deliveryId };
}

async function delivery(id: string) {
  const { rows } = await pool.query('SELECT * FROM deliveries WHERE id = $1', [id]);
  return rows[0]!;
}

async function attempts(deliveryId: string) {
  const { rows } = await pool.query(
    'SELECT attempt_number, outcome, http_status, error_code FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number',
    [deliveryId],
  );
  return rows;
}

async function eventStatus(id: string) {
  return (await pool.query<{ status: string }>('SELECT status FROM events WHERE id = $1', [id]))
    .rows[0]!.status;
}

async function queueSize() {
  const { rows } = await pool.query<{ live: number; dead: number }>(
    `SELECT count(*) FILTER (WHERE dead_lettered_at IS NULL)::int AS live,
            count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead
       FROM local_queue_messages`,
  );
  return rows[0]!;
}

describe('happy path', () => {
  it('delivers a signed webhook and records the outcome before completing the message', async () => {
    const { endpoint, eventId, deliveryId } = await setup();
    expect(await pipeline.pump()).toBe(1);

    expect(receiver.requests).toHaveLength(1);
    const req = receiver.requests[0]!;
    expect(JSON.parse(req.body)).toEqual({
      id: eventId,
      type: 'order.created',
      createdAt: expect.any(String),
      data: { orderId: 'ord_demo_123', amount: 4999, currency: 'EUR' },
    });
    expect(req.headers['relayforge-event-id']).toBe(eventId);
    expect(req.headers['relayforge-delivery-id']).toBe(deliveryId);
    expect(req.headers['relayforge-attempt']).toBe('1');
    expect(
      verifySignature({
        secret: endpoint.signingSecret,
        rawBody: req.body,
        signatureHeader: req.headers['relayforge-signature'] as string,
        timestampHeader: req.headers['relayforge-timestamp'] as string,
      }),
    ).toEqual({ ok: true });

    expect(await delivery(deliveryId)).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
      locked_until: null,
    });
    expect(await attempts(deliveryId)).toEqual([
      { attempt_number: 1, outcome: 'succeeded', http_status: 200, error_code: null },
    ]);
    expect(await eventStatus(eventId)).toBe('completed');
    expect(await queueSize()).toEqual({ live: 0, dead: 0 });
    const outbox = await pool.query('SELECT published_at FROM outbox_events');
    expect(outbox.rows[0]!.published_at).not.toBeNull();
  });

  it('a signature made with the old secret fails after rotation', async () => {
    const { tenant, endpoint } = await setup();
    await api.inject({
      method: 'POST',
      url: `/v1/endpoints/${endpoint.id}/rotate-secret`,
      headers: tenant.headers,
    });
    await pipeline.pump();
    const req = receiver.requests[0]!;
    expect(
      verifySignature({
        secret: endpoint.signingSecret,
        rawBody: req.body,
        signatureHeader: req.headers['relayforge-signature'] as string,
        timestampHeader: req.headers['relayforge-timestamp'] as string,
      }).ok,
    ).toBe(false);
  });
});

describe('retries', () => {
  it('schedules a retry on 500 and succeeds once the receiver recovers', async () => {
    const { eventId, deliveryId } = await setup();
    receiver.reply({ status: 500 });
    await pipeline.pump();

    const failed = await delivery(deliveryId);
    expect(failed.status).toBe('retry_scheduled');
    expect(failed.next_attempt_at).toBeInstanceOf(Date);
    expect(await eventStatus(eventId)).toBe('processing');

    // Not due yet: the scheduler does nothing.
    await pool.query(`UPDATE deliveries SET next_attempt_at = now() + interval '1 hour'`);
    expect(await enqueueDueRetries(pool, 10)).toBe(0);

    await makeRetriesDue(pool);
    expect(await enqueueDueRetries(pool, 10)).toBe(1);
    expect(await delivery(deliveryId)).toMatchObject({ status: 'queued', next_attempt_at: null });
    await pipeline.pump();

    expect(await delivery(deliveryId)).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    expect(await attempts(deliveryId)).toEqual([
      { attempt_number: 1, outcome: 'retryable_failure', http_status: 500, error_code: 'HTTP_500' },
      { attempt_number: 2, outcome: 'succeeded', http_status: 200, error_code: null },
    ]);
    expect(receiver.requests.map((r) => r.headers['relayforge-attempt'])).toEqual(['1', '2']);
    expect(await eventStatus(eventId)).toBe('completed');
  });

  it('honours Retry-After on 429', async () => {
    const { deliveryId } = await setup();
    receiver.reply({ status: 429, headers: { 'retry-after': '7' } });
    const before = Date.now();
    await pipeline.pump();
    const d = await delivery(deliveryId);
    expect(d.status).toBe('retry_scheduled');
    expect((d.next_attempt_at as Date).getTime() - before).toBeGreaterThanOrEqual(6_000);
  });

  it('treats a timeout as retryable', async () => {
    const slow = makePipeline(pool, { timeoutMs: 300 });
    try {
      const { deliveryId } = await setup();
      receiver.reply({ status: 200, delayMs: 1_500 });
      await slow.pump();
      expect(await delivery(deliveryId)).toMatchObject({ status: 'retry_scheduled' });
      expect(await attempts(deliveryId)).toEqual([
        {
          attempt_number: 1,
          outcome: 'retryable_failure',
          http_status: null,
          error_code: 'TIMEOUT',
        },
      ]);
    } finally {
      await slow.close();
    }
  });

  it('treats a refused connection as retryable', async () => {
    const { deliveryId } = await setup('http://127.0.0.1:1/hooks');
    await pipeline.pump();
    expect(await attempts(deliveryId)).toEqual([
      {
        attempt_number: 1,
        outcome: 'retryable_failure',
        http_status: null,
        error_code: 'NETWORK_ERROR',
      },
    ]);
  });

  it('dead-letters after the maximum number of attempts', async () => {
    const { eventId, deliveryId } = await setup();
    receiver.always({ status: 503 });
    for (let i = 0; i < 3; i++) {
      await pipeline.pump();
      await makeRetriesDue(pool);
      await enqueueDueRetries(pool, 10);
    }
    expect(await delivery(deliveryId)).toMatchObject({
      status: 'dead_lettered',
      dead_letter_reason: 'MAX_ATTEMPTS',
      attempt_count: 3,
    });
    expect(await attempts(deliveryId)).toHaveLength(3);
    expect(await eventStatus(eventId)).toBe('failed');
    // Nothing further is scheduled.
    expect(await enqueueDueRetries(pool, 10)).toBe(0);
  });
});

describe('permanent failures and replay', () => {
  it('dead-letters a 400 immediately, then a replay creates a new linked execution', async () => {
    const { tenant, eventId, deliveryId } = await setup();
    receiver.reply({ status: 400 });
    await pipeline.pump();
    expect(await delivery(deliveryId)).toMatchObject({
      status: 'dead_lettered',
      dead_letter_reason: 'PERMANENT_FAILURE',
    });
    expect(await eventStatus(eventId)).toBe('failed');

    const replay = await api.inject({
      method: 'POST',
      url: `/v1/deliveries/${deliveryId}/replay`,
      headers: tenant.headers,
    });
    expect(replay.statusCode).toBe(202);
    const replayed = replay.json<{ id: string; replayOfDeliveryId: string; status: string }>();
    expect(replayed).toMatchObject({ replayOfDeliveryId: deliveryId, status: 'queued' });
    expect(await eventStatus(eventId)).toBe('processing');

    await pipeline.pump();
    expect(await delivery(replayed.id)).toMatchObject({ status: 'succeeded' });
    // History of the original is untouched.
    expect(await delivery(deliveryId)).toMatchObject({ status: 'dead_lettered', attempt_count: 1 });
    expect(await attempts(deliveryId)).toHaveLength(1);
    expect(await eventStatus(eventId)).toBe('completed');
    expect(receiver.requests.map((r) => r.headers['relayforge-event-id'])).toEqual([
      eventId,
      eventId,
    ]);

    const detail = await api.inject({
      url: `/v1/deliveries/${deliveryId}`,
      headers: tenant.headers,
    });
    expect(detail.json().attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: 'permanent_failure',
        httpStatus: 400,
        errorCode: 'HTTP_400',
      }),
    ]);
  });

  it('only replays dead-lettered deliveries, within the replay limit', async () => {
    const limited = await makeApi(pool, { MAX_REPLAYS_PER_DELIVERY: '1' });
    try {
      const { tenant, deliveryId } = await setup();
      const early = await limited.inject({
        method: 'POST',
        url: `/v1/deliveries/${deliveryId}/replay`,
        headers: tenant.headers,
      });
      expect(early.json().error.code).toBe('DELIVERY_NOT_REPLAYABLE');

      await pool.query(`UPDATE deliveries SET status = 'dead_lettered'`);
      const first = await limited.inject({
        method: 'POST',
        url: `/v1/deliveries/${deliveryId}/replay`,
        headers: tenant.headers,
      });
      expect(first.statusCode).toBe(202);
      const second = await limited.inject({
        method: 'POST',
        url: `/v1/deliveries/${deliveryId}/replay`,
        headers: tenant.headers,
      });
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe('REPLAY_LIMIT_EXCEEDED');

      const audit = await pool.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'delivery.replayed'`,
      );
      expect(audit.rows[0]!.n).toBe(1);
    } finally {
      await limited.close();
    }
  });

  it('refuses to replay to a disabled endpoint', async () => {
    const { tenant, endpoint, deliveryId } = await setup();
    await pool.query(`UPDATE deliveries SET status = 'dead_lettered'`);
    await api.inject({
      method: 'PATCH',
      url: `/v1/endpoints/${endpoint.id}`,
      headers: tenant.headers,
      payload: { status: 'disabled' },
    });
    const res = await api.inject({
      method: 'POST',
      url: `/v1/deliveries/${deliveryId}/replay`,
      headers: tenant.headers,
    });
    expect(res.json().error.code).toBe('ENDPOINT_DISABLED');
  });
});

describe('at-least-once safety', () => {
  it('a duplicate broker message does not create a duplicate delivery attempt', async () => {
    const { deliveryId } = await setup();
    const outbox = (await pool.query<{ payload: unknown }>('SELECT payload FROM outbox_events'))
      .rows[0]!;
    await pipeline.relay.relayOnce();
    // Simulate a publisher crash after send but before marking published: the
    // same logical message arrives again (with a different broker message id).
    await pipeline.queue.send([
      { messageId: 'dup-1', subject: 'delivery.requested', body: outbox.payload },
    ]);

    await pipeline.worker.runOnce(10);
    // If both copies were processed concurrently, the loser saw the attempt in
    // flight and was abandoned with a delay; make it visible and process again.
    await pool.query('UPDATE local_queue_messages SET visible_at = now()');
    await pipeline.worker.runOnce(10);
    expect(receiver.requests).toHaveLength(1);
    expect(await attempts(deliveryId)).toHaveLength(1);
    expect(await queueSize()).toEqual({ live: 0, dead: 0 });
  });

  it('republishing the same outbox row is de-duplicated by message id', async () => {
    await setup();
    await pipeline.relay.relayOnce();
    await pool.query('UPDATE outbox_events SET published_at = NULL');
    await pipeline.relay.relayOnce();
    expect((await queueSize()).live).toBe(1);
  });

  it('a stale retry message cannot run an outdated attempt', async () => {
    const { tenant, eventId, deliveryId } = await setup();
    await pipeline.pump(); // attempt 1 succeeds
    await pipeline.queue.send([
      {
        messageId: 'stale-1',
        subject: 'delivery.requested',
        body: { version: 1, deliveryId, tenantId: tenant.tenantId, eventId, attempt: 1 },
      },
    ]);
    await pipeline.worker.runOnce(10);
    expect(receiver.requests).toHaveLength(1);
    expect(await delivery(deliveryId)).toMatchObject({ status: 'succeeded', attempt_count: 1 });
  });

  it('keeps accepted events through a broker outage and publishes them afterwards', async () => {
    const sendFailures = { remaining: 2 };
    const { queue } = pipeline;
    const flaky = makePipeline(pool, {
      sender: {
        async send(messages) {
          if (sendFailures.remaining-- > 0) throw new Error('broker unavailable');
          await queue.send(messages);
        },
        close: async () => undefined,
      },
    });
    try {
      const { deliveryId } = await setup();
      expect(await flaky.relay.relayOnce()).toBe(0);
      const row = (await pool.query('SELECT * FROM outbox_events')).rows[0]!;
      expect(row).toMatchObject({
        published_at: null,
        attempt_count: 1,
        last_error_code: 'BROKER_UNAVAILABLE',
        locked_by: null,
      });

      await pool.query('UPDATE outbox_events SET next_attempt_at = now()');
      expect(await flaky.relay.relayOnce()).toBe(0);
      await pool.query('UPDATE outbox_events SET next_attempt_at = now()');
      expect(await flaky.relay.relayOnce()).toBe(1);

      await flaky.worker.runOnce(10);
      expect(await delivery(deliveryId)).toMatchObject({ status: 'succeeded' });
    } finally {
      await flaky.close();
    }
  });

  it('concurrent publishers never claim the same outbox row', async () => {
    const tenant = await makeTenant(pool);
    await api.inject({
      method: 'POST',
      url: '/v1/endpoints',
      headers: tenant.headers,
      payload: { url: receiver.url },
    });
    for (let i = 0; i < 30; i++) {
      await api.inject({
        method: 'POST',
        url: '/v1/events',
        headers: tenant.headers,
        payload: { type: 'x', data: { i } },
      });
    }
    const sent: string[] = [];
    const recording = {
      send: async (m: { messageId: string }[]) => void sent.push(...m.map((x) => x.messageId)),
      close: async () => undefined,
    };
    const publishers = [1, 2, 3].map(() => makePipeline(pool, { sender: recording }));
    await Promise.all(publishers.map((p) => p.relay.relayOnce()));
    await Promise.all(publishers.map((p) => p.close()));
    expect(sent).toHaveLength(30);
    expect(new Set(sent).size).toBe(30);
  });

  it('a delivery whose worker died mid-attempt is recovered and re-executed', async () => {
    const { deliveryId } = await setup();
    await pipeline.relay.relayOnce();
    // Worker claims the delivery, then "crashes" before recording an outcome.
    const [message] = await pipeline.queue.receive(1);
    expect(message).toBeDefined();
    await pool.query(
      `UPDATE deliveries SET status = 'in_progress', attempt_count = 1, locked_until = now() - interval '1 second' WHERE id = $1`,
      [deliveryId],
    );
    await pool.query('DELETE FROM local_queue_messages');

    expect(await recoverStalledDeliveries(pool, 10)).toBe(1);
    expect(await delivery(deliveryId)).toMatchObject({ status: 'queued', attempt_count: 0 });
    await pipeline.pump();
    expect(await delivery(deliveryId)).toMatchObject({ status: 'succeeded', attempt_count: 1 });
  });

  it('dead-letters malformed messages on the queue', async () => {
    await pipeline.queue.send([
      { messageId: 'bad-1', subject: 'delivery.requested', body: { version: 99 } },
    ]);
    await pipeline.worker.runOnce(10);
    const { rows } = await pool.query('SELECT dead_letter_reason FROM local_queue_messages');
    expect(rows).toEqual([{ dead_letter_reason: 'INVALID_MESSAGE' }]);
  });

  it('does not complete the message when the outcome cannot be persisted', async () => {
    const { deliveryId } = await setup();
    await pipeline.relay.relayOnce();
    await pool.query(
      `ALTER TABLE delivery_attempts ADD CONSTRAINT test_block CHECK (attempt_number < 0) NOT VALID`,
    );
    try {
      await pipeline.worker.runOnce(10);
    } finally {
      await pool.query('ALTER TABLE delivery_attempts DROP CONSTRAINT test_block');
    }
    expect((await queueSize()).live).toBe(1);
    expect(await delivery(deliveryId)).toMatchObject({ status: 'in_progress' });
  });
});

describe('policy at delivery time', () => {
  it('cancels deliveries for endpoints disabled after acceptance', async () => {
    const { tenant, endpoint, eventId, deliveryId } = await setup();
    await api.inject({
      method: 'PATCH',
      url: `/v1/endpoints/${endpoint.id}`,
      headers: tenant.headers,
      payload: { status: 'disabled' },
    });
    await pipeline.pump();
    expect(receiver.requests).toHaveLength(0);
    expect(await delivery(deliveryId)).toMatchObject({ status: 'cancelled' });
    expect(await attempts(deliveryId)).toHaveLength(0);
    expect(await eventStatus(eventId)).toBe('failed');
  });

  it('the HTTP client refuses hostnames that resolve to private addresses (DNS pinning)', async () => {
    // Bypasses the static URL check on purpose: proves the connect-time lookup guard itself.
    const client = new WebhookHttpClient({ timeoutMs: 2_000, allowInsecure: false });
    try {
      const port = new URL(receiver.url).port;
      const result = await client.post(new URL(`http://localhost:${port}/hooks`), {}, '{}');
      expect(result).toMatchObject({ kind: 'error', code: 'DESTINATION_BLOCKED' });
      expect(receiver.requests).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('re-checks the URL policy on every attempt', async () => {
    const strict = makePipeline(pool, { allowInsecure: false });
    try {
      const { deliveryId } = await setup();
      await strict.pump();
      expect(receiver.requests).toHaveLength(0);
      expect(await delivery(deliveryId)).toMatchObject({
        status: 'dead_lettered',
        dead_letter_reason: 'ENDPOINT_POLICY_BLOCKED',
      });
      expect(await attempts(deliveryId)).toEqual([
        {
          attempt_number: 1,
          outcome: 'permanent_failure',
          http_status: null,
          error_code: 'DESTINATION_BLOCKED',
        },
      ]);
    } finally {
      await strict.close();
    }
  });
});
