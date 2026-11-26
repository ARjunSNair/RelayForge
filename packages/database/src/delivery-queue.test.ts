import { describe, expect, it, vi } from 'vitest';
import { enqueueDeliveries, refreshEventStatus } from './delivery-queue.js';
import type { Queryable } from './index.js';

function fakeDb() {
  const query = vi.fn(async () => ({ rows: [] }));
  return { db: { query } as unknown as Queryable, query };
}

describe('enqueueDeliveries', () => {
  it('does nothing for an empty batch', async () => {
    const { db, query } = fakeDb();
    await enqueueDeliveries(db, []);
    expect(query).not.toHaveBeenCalled();
  });

  it('writes one outbox statement with parallel arrays, defaulting traceparent to null', async () => {
    const { db, query } = fakeDb();
    await enqueueDeliveries(db, [
      { deliveryId: 'd1', tenantId: 't1', eventId: 'e1', attempt: 1, traceparent: 'tp-1' },
      { deliveryId: 'd2', tenantId: 't1', eventId: 'e2', attempt: 3 },
      { deliveryId: 'd3', tenantId: 't2', eventId: 'e3', attempt: 2, traceparent: null },
    ]);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("'delivery.requested'");
    expect(params).toEqual([
      ['d1', 'd2', 'd3'],
      ['t1', 't1', 't2'],
      ['e1', 'e2', 'e3'],
      [1, 3, 2],
      ['tp-1', null, null],
    ]);
  });
});

describe('refreshEventStatus', () => {
  it('scopes the recomputation to the tenant and event', async () => {
    const { db, query } = fakeDb();
    await refreshEventStatus(db, 'tenant-1', 'event-1');
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('UPDATE events');
    expect(params).toEqual(['tenant-1', 'event-1']);
  });
});
