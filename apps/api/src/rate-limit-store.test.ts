import type { Pool } from '@relayforge/database';
import { describe, expect, it, vi } from 'vitest';
import { postgresRateLimitStore } from './rate-limit-store.js';

function fakePool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

function incr(
  store: { incr: (...args: never[]) => void },
  key: string,
  timeWindow?: number,
): Promise<{ error: Error | null; result?: { current: number; ttl: number } }> {
  return new Promise((resolve) => {
    (store.incr as (k: string, cb: (e: Error | null, r?: never) => void, t?: number) => void)(
      key,
      (error, result) => resolve({ error, result }),
      timeWindow,
    );
  });
}

describe('postgresRateLimitStore', () => {
  it('upserts a counter under the prefixed key and returns count and ttl', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 3, ttl: 1200 }] });
    const Store = postgresRateLimitStore(fakePool(query), 'tenant:');
    const store = new Store({}) as unknown as Parameters<typeof incr>[0];

    const { error, result } = await incr(store, 'abc', 30_000);

    expect(error).toBeNull();
    expect(result).toEqual({ current: 3, ttl: 1200 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual(['tenant:abc', 30_000]);
  });

  it('defaults to a 60 second window', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 1, ttl: 0 }] });
    const store = new (postgresRateLimitStore(fakePool(query)))({}) as unknown as Parameters<
      typeof incr
    >[0];

    await incr(store, 'k');

    expect(query.mock.calls[0]![1]).toEqual(['k', 60_000]);
  });

  it('reports query failures through the callback so the plugin can fail open', async () => {
    const boom = new Error('connection terminated');
    const store = new (postgresRateLimitStore(fakePool(vi.fn().mockRejectedValue(boom))))(
      {},
    ) as unknown as Parameters<typeof incr>[0];

    const { error, result } = await incr(store, 'k');

    expect(error).toBe(boom);
    expect(result).toBeUndefined();
  });

  it('namespaces per-route children by method and url', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 1, ttl: 10 }] });
    const store = new (postgresRateLimitStore(fakePool(query), 'p:'))({}) as unknown as {
      child: (o: unknown) => Parameters<typeof incr>[0];
    };

    const child = store.child({ routeInfo: { method: 'POST', url: '/v1/events' } });
    await incr(child, 'tenant-1');

    expect(query.mock.calls[0]![1]).toEqual(['p:POST/v1/events:tenant-1', 60_000]);
  });
});
