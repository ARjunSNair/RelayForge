import type { Pool } from '@relayforge/database';
import type { QueueSender } from '@relayforge/messaging';
import { createLogger } from '@relayforge/observability';
import { describe, expect, it, vi } from 'vitest';
import { OutboxRelay } from './outbox-relay.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const opts = { owner: 'pub-1', batchSize: 10, leaseMs: 30_000, retryBaseMs: 100, retryCapMs: 200 };

function row(id: string, attempt: number, traceparent: string | null = null) {
  return {
    id,
    event_id: `evt-${id}`,
    message_type: 'delivery.requested',
    payload: { id },
    attempt_count: attempt,
    traceparent,
  };
}

function setup(rows: ReturnType<typeof row>[], send: QueueSender['send']) {
  const query = vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValue({ rows: [] });
  const sender: QueueSender = { send, close: vi.fn() };
  const relay = new OutboxRelay({ query } as unknown as Pool, sender, logger, opts);
  return { query, relay };
}

describe('OutboxRelay', () => {
  it('does nothing when no rows are due', async () => {
    const send = vi.fn();
    const { query, relay } = setup([], send);
    expect(await relay.relayOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('publishes with the outbox id as message id and marks rows published', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { query, relay } = setup([row('a', 1, '00-tp-01'), row('b', 1)], send);
    expect(await relay.relayOnce()).toBe(2);
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: 'a', correlationId: 'evt-a', traceparent: '00-tp-01' }),
      expect.not.objectContaining({ traceparent: expect.anything() }),
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([['a', 'b'], 'pub-1']);
    expect(String(query.mock.calls[1]?.[0])).toContain('published_at = now()');
  });

  it('releases the lease with a capped backoff when the broker fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('broker down'));
    const { query, relay } = setup([row('a', 1), row('b', 9)], send);
    expect(await relay.relayOnce()).toBe(0);
    const [sql, params] = query.mock.calls[1] as [string, [string[], string, string, number]];
    expect(sql).toContain('locked_by = NULL');
    expect(sql).not.toContain('published_at = now()');
    expect(params.slice(0, 3)).toEqual([['a', 'b'], 'pub-1', 'BROKER_UNAVAILABLE']);
    expect(params[3]).toBeGreaterThanOrEqual(0);
    expect(params[3]).toBeLessThanOrEqual(200);
  });
});
