import { loadApiConfig } from '@relayforge/config';
import { createPool } from '@relayforge/database';
import { SecretKeyring } from '@relayforge/security';
import { rewrapSigningSecrets } from '../key-rotation.js';

/**
 * Re-encrypt endpoint signing secrets under the primary data-encryption key,
 * after SIGNING_SECRET_ENCRYPTION_KEY/_KEY_ID were changed and the old key was
 * moved to SIGNING_SECRET_PREVIOUS_KEYS. Safe to re-run.
 */
const config = loadApiConfig();
const pool = createPool(config.DATABASE_URL, 2);
try {
  const keyring = new SecretKeyring(
    config.SIGNING_SECRET_ENCRYPTION_KEY_ID,
    config.SIGNING_SECRET_ENCRYPTION_KEY,
    SecretKeyring.parsePrevious(config.SIGNING_SECRET_PREVIOUS_KEYS),
  );
  const result = await rewrapSigningSecrets(pool, keyring);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
