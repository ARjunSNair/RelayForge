import type { Pool } from '@relayforge/database';
import { describe, expect, it, vi } from 'vitest';
import { runRetention } from './retention.js';

const policy = { eventDays: 30, outboxHours: 48, queueDeadLetterDays: 7, batchSize: 100 };

describe('runRetention', () => {
  it('passes each policy window to its statement and sums outbox deletions', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ events: 2, deliveries: 3, attempts: 5, outbox: 4 }] })
      .mockResolvedValueOnce({ rowCount: 6 })
      .mockResolvedValueOnce({ rowCount: 7 })
      .mockResolvedValueOnce({ rowCount: 8 });

    const counts = await runRetention({ query } as unknown as Pool, policy);

    expect(counts).toEqual({
      events: 2,
      deliveries: 3,
      delivery_attempts: 5,
      outbox_events: 10,
      local_queue_messages: 7,
      rate_limit_counters: 8,
    });
    expect(query.mock.calls.map((c) => c[1])).toEqual([[30, 100], [48, 100], [7, 100], [1000]]);
  });

  it('reports zero when the driver gives no row counts', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ events: 0, deliveries: 0, attempts: 0, outbox: 0 }] })
      .mockResolvedValue({ rowCount: null });

    const counts = await runRetention({ query } as unknown as Pool, policy);

    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});
