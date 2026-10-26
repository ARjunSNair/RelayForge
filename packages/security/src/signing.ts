import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_VERSION = 'v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * RelayForge-Signature: v1=<hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))>
 *
 * The exact bytes signed are the ASCII decimal timestamp, a single '.', and
 * the raw request body bytes as sent on the wire.
 */
export function signPayload(secret: string, timestamp: number, rawBody: string | Buffer): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'MALFORMED_HEADER' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'SIGNATURE_MISMATCH' };

/**
 * Reference verifier for receivers. Accepts a header with several
 * comma-separated signatures (e.g. during secret rotation).
 */
export function verifySignature(input: {
  secret: string;
  rawBody: string | Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  toleranceSeconds?: number;
  now?: number;
}): VerifyResult {
  const { secret, rawBody, signatureHeader, timestampHeader } = input;
  if (!signatureHeader || !timestampHeader || !/^\d{1,12}$/.test(timestampHeader)) {
    return { ok: false, reason: 'MALFORMED_HEADER' };
  }
  const timestamp = Number(timestampHeader);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  }
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody), 'utf8');
  const matches = signatureHeader
    .split(',')
    .map((s) => Buffer.from(s.trim(), 'utf8'))
    .some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
  return matches ? { ok: true } : { ok: false, reason: 'SIGNATURE_MISMATCH' };
}
