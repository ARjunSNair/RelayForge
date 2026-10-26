import { parseArgs } from 'node:util';
import { createPool } from '@relayforge/database';
import { createTenantWithApiKey } from '../tenants.js';

const { values } = parseArgs({
  options: { name: { type: 'string' }, test: { type: 'boolean', default: false } },
});

const url = process.env['DATABASE_URL'];
if (!url || !values.name) {
  console.error('Usage: DATABASE_URL=... pnpm admin:create-tenant --name "Acme" [--test]');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const result = await createTenantWithApiKey(pool, values.name, {
    mode: values.test ? 'test' : 'live',
  });
  // Printed once to the operator's terminal; it cannot be recovered later.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}
