import { createPool } from '../index.js';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../migrate.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const applied = await migrate(pool, process.env['MIGRATIONS_DIR'] ?? DEFAULT_MIGRATIONS_DIR);
  console.warn(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} finally {
  await pool.end();
}
