import { loadApiConfig } from '@relayforge/config';
import { createPool } from '@relayforge/database';
import { SecretBox } from '@relayforge/security';
import { buildApp } from './app.js';

const config = loadApiConfig();
const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const app = await buildApp({
  pool,
  config,
  secretBox: new SecretBox(config.SIGNING_SECRET_ENCRYPTION_KEY),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
