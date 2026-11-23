import type { Pool } from '@relayforge/database';
import { describe, expect, it, vi } from 'vitest';
import { enqueueDueRetries, recoverStalledDeliveries } from './retry-scheduler.js';

describe('retry scheduler', () => {
  it('enqueueDueRetries returns the number of requeued deliveries', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3 });
    expect(await enqueueDueRetries({ query } as unknown as Pool, 50)).toBe(3);
    expect(query.mock.calls[0]?.[1]).toEqual([50]);
    expect(String(query.mock.calls[0]?.[0])).toContain("status = 'retry_scheduled'");
  });

  it('recoverStalledDeliveries rolls the attempt back and returns the count', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    expect(await recoverStalledDeliveries({ query } as unknown as Pool, 10)).toBe(2);
    expect(query.mock.calls[0]?.[1]).toEqual([10]);
    expect(String(query.mock.calls[0]?.[0])).toContain('attempt_count = d.attempt_count - 1');
  });

  it('treats a missing rowCount as zero', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: null });
    const pool = { query } as unknown as Pool;
    expect(await enqueueDueRetries(pool, 1)).toBe(0);
    expect(await recoverStalledDeliveries(pool, 1)).toBe(0);
  });
});
