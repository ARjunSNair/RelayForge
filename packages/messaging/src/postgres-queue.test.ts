import type { Pool } from '@relayforge/database';
import { describe, expect, it, vi } from 'vitest';
import { PostgresQueue } from './postgres-queue.js';

function fakeQueue(rows: unknown[] = []) {
  const query = vi.fn(async () => ({ rows }));
  return { queue: new PostgresQueue({ query } as unknown as Pool, 'deliveries', 30_000), query };
}

const call = (query: ReturnType<typeof fakeQueue>['query'], n = 0) =>
  query.mock.calls[n] as unknown as [string, unknown[]];

describe('PostgresQueue.send', () => {
  it('does nothing for an empty batch', async () => {
    const { queue, query } = fakeQueue();
    await queue.send([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('inserts parallel arrays and de-duplicates on (queue, message_id)', async () => {
    const { queue, query } = fakeQueue();
    await queue.send([
      { messageId: 'm1', subject: 'delivery.requested', body: { a: 1 }, correlationId: 'c1' },
      { messageId: 'm2', subject: 'delivery.requested', body: { b: 2 }, traceparent: 'tp' },
    ]);
    const [sql, params] = call(query);
    expect(sql).toContain('ON CONFLICT (queue, message_id) DO NOTHING');
    expect(params[0]).toBe('deliveries');
    expect(params[1]).toEqual(['m1', 'm2']);
    expect(params[2]).toEqual(['{"a":1}', '{"b":2}']);
    expect((params[3] as string[]).map((p) => JSON.parse(p))).toEqual([
      { subject: 'delivery.requested', correlationId: 'c1' },
      { subject: 'delivery.requested', traceparent: 'tp' },
    ]);
  });
});

describe('PostgresQueue.receive', () => {
  it('maps rows to messages, omitting absent optional properties', async () => {
    const { queue, query } = fakeQueue([
      {
        message_id: 'm1',
        body: { x: 1 },
        properties: { subject: 's', correlationId: 'c', traceparent: 'tp' },
        delivery_count: 2,
        lock_token: 'lock-1',
      },
      { message_id: 'm2', body: null, properties: {}, delivery_count: 1, lock_token: 'lock-2' },
    ]);
    const messages = await queue.receive(5);
    expect(call(query)[1]).toEqual(['deliveries', 5, 30_000]);
    expect(messages).toEqual([
      {
        messageId: 'm1',
        subject: 's',
        body: { x: 1 },
        deliveryCount: 2,
        correlationId: 'c',
        traceparent: 'tp',
      },
      { messageId: 'm2', subject: '', body: null, deliveryCount: 1 },
    ]);
  });
});

describe('PostgresQueue settlement', () => {
  async function received() {
    const { queue, query } = fakeQueue([
      { message_id: 'm1', body: {}, properties: {}, delivery_count: 1, lock_token: 'lock-1' },
    ]);
    const [message] = await queue.receive(1);
    query.mockClear();
    return { queue, query, message: message! };
  }

  it('completes with the lock token from receive', async () => {
    const { queue, query, message } = await received();
    await queue.complete(message);
    const [sql, params] = call(query);
    expect(sql).toContain('DELETE FROM local_queue_messages');
    expect(params).toEqual(['deliveries', 'm1', 'lock-1']);
  });

  it('abandons with the requested delay, defaulting to none', async () => {
    const { queue, query, message } = await received();
    await queue.abandon(message);
    await queue.abandon(message, 5_000);
    expect(call(query, 0)[1]).toEqual(['deliveries', 'm1', 'lock-1', 0]);
    expect(call(query, 1)[1]).toEqual(['deliveries', 'm1', 'lock-1', 5_000]);
  });

  it('dead-letters with the reason', async () => {
    const { queue, query, message } = await received();
    await queue.deadLetter(message, 'poison');
    expect(call(query)[1]).toEqual(['deliveries', 'm1', 'lock-1', 'poison']);
  });

  it('never matches a real lock for a message it did not receive', async () => {
    const { queue, query } = fakeQueue();
    const stranger = { messageId: 'm1', subject: '', body: {}, deliveryCount: 1 };
    await queue.complete(stranger);
    await queue.complete(stranger);
    const first = call(query, 0)[1][2];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(call(query, 1)[1][2]).not.toBe(first);
  });
});
