import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, isWellFormedApiKey } from './api-keys.js';
import { canonicalJson, fingerprint } from './fingerprint.js';
import { SecretBox } from './secret-box.js';
import { generateSigningSecret, signPayload, verifySignature } from './signing.js';

describe('API keys', () => {
  it('generates prefixed keys whose hash, not value, is stored', () => {
    const live = generateApiKey('live');
    expect(live.key).toMatch(/^rf_live_/);
    expect(isWellFormedApiKey(live.key)).toBe(true);
    expect(live.hash).toBe(hashApiKey(live.key));
    expect(live.hash).not.toContain(live.key.slice(8));
    expect(generateApiKey('test').key).toMatch(/^rf_test_/);
  });

  it('rejects malformed keys', () => {
    expect(isWellFormedApiKey('rf_live_short')).toBe(false);
    expect(isWellFormedApiKey(`sk_live_${'a'.repeat(43)}`)).toBe(false);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));

  it('round-trips and uses a fresh IV each time', () => {
    const a = box.encrypt('whsec_example');
    const b = box.encrypt('whsec_example');
    expect(a.equals(b)).toBe(false);
    expect(box.decrypt(a)).toBe('whsec_example');
  });

  it('detects tampering', () => {
    const sealed = box.encrypt('whsec_example');
    sealed[sealed.length - 20]! ^= 0xff;
    expect(() => box.decrypt(sealed)).toThrow();
  });

  it('rejects the wrong key', () => {
    const other = new SecretBox(randomBytes(32).toString('base64'));
    expect(() => other.decrypt(box.encrypt('x'))).toThrow();
  });
});

describe('webhook signatures', () => {
  const secret = generateSigningSecret();
  const body = JSON.stringify({ id: 'evt', data: { amount: 4999 } });
  const ts = 1_760_000_000;

  it('matches an independently computed test vector', () => {
    // printf '1700000000.{}' | openssl dgst -sha256 -hmac whsec_test
    expect(signPayload('whsec_test', 1_700_000_000, '{}')).toBe(
      'v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91',
    );
  });

  it('verifies a valid signature within tolerance', () => {
    const header = signPayload(secret, ts, body);
    expect(
      verifySignature({
        secret,
        rawBody: body,
        signatureHeader: header,
        timestampHeader: String(ts),
        now: ts + 10,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts any of several signatures (rotation)', () => {
    const header = `v1=${'0'.repeat(64)}, ${signPayload(secret, ts, body)}`;
    expect(
      verifySignature({
        secret,
        rawBody: body,
        signatureHeader: header,
        timestampHeader: String(ts),
        now: ts,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['tampered body', { rawBody: `${body} `, now: ts }, 'SIGNATURE_MISMATCH'],
    ['stale timestamp', { rawBody: body, now: ts + 301 }, 'TIMESTAMP_OUT_OF_TOLERANCE'],
  ] as const)('rejects %s', (_label, input, reason) => {
    const header = signPayload(secret, ts, body);
    expect(
      verifySignature({ secret, signatureHeader: header, timestampHeader: String(ts), ...input }),
    ).toEqual({
      ok: false,
      reason,
    });
  });

  it('rejects missing headers', () => {
    expect(
      verifySignature({ secret, rawBody: body, signatureHeader: undefined, timestampHeader: '1' })
        .ok,
    ).toBe(false);
  });
});

describe('fingerprint', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('differs for different values', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });
});
