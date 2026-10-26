import { createHash, randomBytes } from 'node:crypto';

export type ApiKeyMode = 'live' | 'test';

const KEY_PATTERN = /^rf_(live|test)_[A-Za-z0-9_-]{43}$/;

/**
 * Generate an API key: `rf_<mode>_<43 chars of base64url(32 random bytes)>`.
 * Only the hash is persisted; `key` is shown once.
 */
export function generateApiKey(mode: ApiKeyMode = 'live'): {
  key: string;
  hash: string;
  prefix: string;
} {
  const key = `rf_${mode}_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 16) };
}

/**
 * SHA-256 is appropriate here (rather than a slow password hash) because keys
 * carry 256 bits of entropy and are never user-chosen. Lookup is by hash, so
 * the raw key is never compared byte-by-byte.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Cheap syntactic check so obviously malformed keys never reach the database. */
export function isWellFormedApiKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}
