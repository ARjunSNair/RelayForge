import { createPool, migrate } from '@relayforge/database';

/**
 * Integration tests need a real PostgreSQL. DATABASE_URL must point at a
 * disposable database: the schema is dropped and re-created on every run.
 */
export default async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Integration tests require DATABASE_URL (a disposable test database)');
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error('Refusing to reset a database whose name does not contain "test"');
  }
  const pool = createPool(url, 1);
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
