import pg from 'pg';

export type { Pool, PoolClient, QueryResultRow } from 'pg';
export { migrate } from './migrate.js';
export * from './delivery-queue.js';

/** Anything that can run a query: a pool or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Run `fn` in a transaction. Commits on success, rolls back on any error.
 * Keep network calls (HTTP, broker) out of `fn`: transactions must stay short.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Readiness probe with a bounded timeout. */
export async function checkDatabase(pool: pg.Pool, timeoutMs = 1_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([pool.query('SELECT 1').then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** True when `error` is a PostgreSQL unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}
