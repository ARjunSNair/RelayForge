import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './pagination.js';

describe('cursor', () => {
  it('round-trips with microsecond precision intact', () => {
    const cursor = {
      createdAt: '2026-10-21 12:00:00.123456+00',
      id: '0b6f1f0e-3f2a-4c43-9d0a-1f5a2b3c4d5e',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    '',
    'not-base64!',
    Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from('["x","y"]').toString('base64url'),
  ])('rejects %j', (raw) => {
    expect(() => decodeCursor(raw)).toThrow(/cursor is invalid/);
  });
});
