import type { Pool } from '@relayforge/database';
import { SecretKeyring } from '@relayforge/security';
import { describe, expect, it, vi } from 'vitest';
import { rewrapSigningSecrets } from './key-rotation.js';

const OLD_KEY = Buffer.alloc(32, 1).toString('base64');
const NEW_KEY = Buffer.alloc(32, 2).toString('base64');

const oldRing = new SecretKeyring('old', OLD_KEY);
const ring = new SecretKeyring('new', NEW_KEY, [{ id: 'old', key: OLD_KEY }]);

function row(id: string, secret: string, previous?: string) {
  const current = oldRing.encrypt(secret);
  const prev = previous === undefined ? null : oldRing.encrypt(previous);
  return {
    id,
    signing_secret_ciphertext: current.ciphertext,
    signing_secret_key_id: current.keyId,
    previous_signing_secret_ciphertext: prev?.ciphertext ?? null,
    previous_signing_secret_key_id: prev?.keyId ?? null,
  };
}

/** Each SELECT ... FOR UPDATE returns the next queued batch; UPDATEs are recorded. */
function fakePool(batches: Array<ReturnType<typeof row>[]>, remaining: number) {
  const updates: unknown[][] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) return { rows: batches.shift() ?? [] };
      if (sql.includes('UPDATE webhook_endpoints')) updates.push(params ?? []);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: async () => client,
    query: vi.fn(async () => ({ rows: [{ n: remaining }] })),
  } as unknown as Pool;
  return { pool, updates };
}

describe('rewrapSigningSecrets', () => {
  it('re-seals current and previous secrets under the primary key without changing them', async () => {
    const { pool, updates } = fakePool(
      [[row('a', 'secret-a', 'prior-a'), row('b', 'secret-b')]],
      0,
    );

    await expect(rewrapSigningSecrets(pool, ring)).resolves.toEqual({ rewrapped: 2, remaining: 0 });

    const [a, b] = updates as [
      [string, Buffer, string, Buffer | null, string | null],
      [string, Buffer, string, Buffer | null, string | null],
    ];
    expect(a[0]).toBe('a');
    expect(a[2]).toBe('new');
    expect(ring.decrypt({ keyId: 'new', ciphertext: a[1] })).toBe('secret-a');
    expect(a[4]).toBe('new');
    expect(ring.decrypt({ keyId: 'new', ciphertext: a[3]! })).toBe('prior-a');
    // A row without an overlap-window secret keeps both previous columns null.
    expect(b[2]).toBe('new');
    expect(b[3]).toBeNull();
    expect(b[4]).toBeNull();
  });

  it('keeps going while batches are full and stops on a short one', async () => {
    const { pool, updates } = fakePool(
      [[row('a', 'one'), row('b', 'two')], [row('c', 'three')]],
      0,
    );
    await expect(rewrapSigningSecrets(pool, ring, 2)).resolves.toEqual({
      rewrapped: 3,
      remaining: 0,
    });
    expect(updates.map((u) => u[0])).toEqual(['a', 'b', 'c']);
  });

  it('reports rows it could not rewrap as remaining', async () => {
    const { pool } = fakePool([], 4);
    await expect(rewrapSigningSecrets(pool, ring)).resolves.toEqual({ rewrapped: 0, remaining: 4 });
  });

  it('fails without writing when a row was sealed with a key that is no longer configured', async () => {
    const { pool, updates } = fakePool([[row('a', 'secret')]], 1);
    const withoutOld = new SecretKeyring('new', NEW_KEY);
    await expect(rewrapSigningSecrets(pool, withoutOld)).rejects.toThrow(
      'Unknown encryption key id "old"',
    );
    expect(updates).toEqual([]);
  });
});
