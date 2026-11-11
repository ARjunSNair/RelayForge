import { describe, expect, it } from 'vitest';
import { extractBearerToken } from './auth.js';

describe('extractBearerToken', () => {
  it('extracts the token and accepts any case for the scheme', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER   abc  ')).toBe('abc');
  });

  it('rejects missing, empty and non-bearer credentials', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer a b')).toBeUndefined();
  });
});
