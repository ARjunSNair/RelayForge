import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from './index.js';
import { checkDatabase, isUniqueViolation, migrate, withTransaction } from './index.js';

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** A pool whose single client records every statement and delegates to `handler`. */
function fakePool(handler: QueryFn = async () => ({ rows: [] })) {
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      return handler(sql, params);
    }),
    release,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, statements, release };
}

describe('withTransaction', () => {
  it('commits and releases the client on success', async () => {
    const { pool, statements, release } = fakePool();
    await expect(withTransaction(pool, async () => 42)).resolves.toBe(42);
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back, rethrows the original error and releases the client on failure', async () => {
    const { pool, statements, release } = fakePool(async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [] };
    });
    const boom = new Error('boom');
    await expect(
      withTransaction(pool, async (_client: PoolClient) => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('checkDatabase', () => {
  it('is true when the probe query succeeds', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    await expect(checkDatabase(pool)).resolves.toBe(true);
  });

  it('is false when the probe query fails', async () => {
    const pool = {
      query: async () => {
        throw new Error('down');
      },
    } as unknown as Pool;
    await expect(checkDatabase(pool)).resolves.toBe(false);
  });

  it('is false when the probe does not answer within the timeout', async () => {
    const pool = { query: () => new Promise(() => undefined) } as unknown as Pool;
    await expect(checkDatabase(pool, 10)).resolves.toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('matches only PostgreSQL error code 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('migrate', () => {
  async function migrationsDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'relayforge-migrations-'));
    for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
    return dir;
  }

  it('applies pending migrations in numeric order, skipping applied and non-migration files', async () => {
    const dir = await migrationsDir({
      '002_b.sql': 'SELECT 2',
      '001_a.sql': 'SELECT 1',
      '003_c.sql': 'SELECT 3',
      'README.md': 'not a migration',
      'notes.sql': 'no numeric prefix',
    });
    const executed: string[] = [];
    const { pool, release } = fakePool(async (sql) => {
      if (sql.startsWith('SELECT name')) return { rows: [{ name: '001_a.sql' }] };
      if (/^SELECT [123]$/.test(sql)) executed.push(sql);
      return { rows: [] };
    });

    await expect(migrate(pool, dir)).resolves.toEqual(['002_b.sql', '003_c.sql']);
    expect(executed).toEqual(['SELECT 2', 'SELECT 3']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back, names the failing file and still unlocks and releases', async () => {
    const dir = await migrationsDir({ '001_a.sql': 'SELECT 1', '002_bad.sql': 'SELECT bad' });
    const { pool, statements, release } = fakePool(async (sql) => {
      if (sql === 'SELECT bad') throw new Error('syntax error');
      return { rows: [] };
    });

    await expect(migrate(pool, dir)).rejects.toThrow('Migration 002_bad.sql failed: syntax error');
    expect(statements).toContain('ROLLBACK');
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock($1)');
    expect(release).toHaveBeenCalledOnce();
  });
});
