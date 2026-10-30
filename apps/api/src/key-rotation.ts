import { withTransaction, type Pool } from '@relayforge/database';
import type { SecretKeyring } from '@relayforge/security';

interface SealedColumns {
  id: string;
  signing_secret_ciphertext: Buffer;
  signing_secret_key_id: string;
  previous_signing_secret_ciphertext: Buffer | null;
  previous_signing_secret_key_id: string | null;
}

/**
 * Rewrap every signing secret (current and overlap-window previous) that is
 * not sealed with the keyring's primary key. Runs in small batches with row
 * locks, so it can run while the API and workers are serving traffic.
 * Once it reports `remaining: 0`, old keys can be removed from configuration.
 */
export async function rewrapSigningSecrets(
  pool: Pool,
  keyring: SecretKeyring,
  batchSize = 100,
): Promise<{ rewrapped: number; remaining: number }> {
  const primary = keyring.primaryKeyId;
  let rewrapped = 0;
  for (;;) {
    const n = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<SealedColumns>(
        `SELECT id, signing_secret_ciphertext, signing_secret_key_id,
                previous_signing_secret_ciphertext, previous_signing_secret_key_id
           FROM webhook_endpoints
          WHERE signing_secret_key_id <> $1 OR previous_signing_secret_key_id <> $1
          ORDER BY id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [primary, batchSize],
      );
      for (const row of rows) {
        const current = keyring.encrypt(
          keyring.decrypt({
            keyId: row.signing_secret_key_id,
            ciphertext: row.signing_secret_ciphertext,
          }),
        );
        const previous =
          row.previous_signing_secret_ciphertext && row.previous_signing_secret_key_id
            ? keyring.encrypt(
                keyring.decrypt({
                  keyId: row.previous_signing_secret_key_id,
                  ciphertext: row.previous_signing_secret_ciphertext,
                }),
              )
            : null;
        await tx.query(
          `UPDATE webhook_endpoints
              SET signing_secret_ciphertext = $2, signing_secret_key_id = $3,
                  previous_signing_secret_ciphertext = $4, previous_signing_secret_key_id = $5
            WHERE id = $1`,
          [
            row.id,
            current.ciphertext,
            current.keyId,
            previous?.ciphertext ?? null,
            previous?.keyId ?? null,
          ],
        );
      }
      return rows.length;
    });
    rewrapped += n;
    if (n < batchSize) break;
  }
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM webhook_endpoints
      WHERE signing_secret_key_id <> $1 OR previous_signing_secret_key_id <> $1`,
    [primary],
  );
  return { rewrapped, remaining: rows[0]!.n };
}
