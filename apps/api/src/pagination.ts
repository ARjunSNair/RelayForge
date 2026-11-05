import { AppError } from '@relayforge/contracts';

/**
 * Opaque keyset cursor over (created_at, id) descending. created_at is carried
 * as PostgreSQL text so microsecond precision survives the round trip.
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

// Shapes of what PostgreSQL emits for timestamptz::text and uuid::text. Anything looser
// (Date.parse accepts many formats PostgreSQL does not) would surface as a 500 from the cast.
const CREATED_AT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      CREATED_AT.test(parsed[0]) &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      typeof parsed[1] === 'string' &&
      UUID.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_ERROR', 'cursor is invalid');
}
