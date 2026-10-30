import { parseArgs } from 'node:util';
import { createPool } from '@relayforge/database';
import { createApiKey } from '../tenants.js';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    name: { type: 'string' },
    scopes: { type: 'string' },
    test: { type: 'boolean', default: false },
  },
});

const url = process.env['DATABASE_URL'];
if (!url || !values.tenant) {
  console.error(
    'Usage: DATABASE_URL=... pnpm admin:create-api-key --tenant <tenant-id> [--name "CI"] [--scopes a,b] [--test]',
  );
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const result = await createApiKey(pool, values.tenant, {
    mode: values.test ? 'test' : 'live',
    ...(values.name ? { name: values.name } : {}),
    ...(values.scopes ? { scopes: values.scopes.split(',').map((s) => s.trim()) } : {}),
  });
  // Printed once to the operator's terminal; it cannot be recovered later.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}
