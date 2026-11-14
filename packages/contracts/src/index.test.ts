import { describe, expect, it } from 'vitest';
import { AppError, DeliveryRequestedV1, ERROR_STATUS } from './index.js';

const valid = {
  version: 1,
  deliveryId: '5f0c1f0e-3b7a-4f6e-9a55-0d6f1f6f3a11',
  tenantId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  eventId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  attempt: 1,
};

describe('DeliveryRequestedV1', () => {
  it('accepts a well-formed message', () => {
    expect(DeliveryRequestedV1.parse(valid)).toEqual(valid);
  });

  it('rejects other message versions', () => {
    expect(DeliveryRequestedV1.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects attempt %s', (attempt) => {
    expect(DeliveryRequestedV1.safeParse({ ...valid, attempt }).success).toBe(false);
  });

  it.each(['deliveryId', 'tenantId', 'eventId'])('requires %s to be a UUID', (field) => {
    expect(DeliveryRequestedV1.safeParse({ ...valid, [field]: 'not-a-uuid' }).success).toBe(false);
    expect(DeliveryRequestedV1.safeParse({ ...valid, [field]: undefined }).success).toBe(false);
  });
});

describe('AppError', () => {
  it('derives its HTTP status from the error code', () => {
    const err = new AppError('RATE_LIMITED', 'slow down');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toBe('slow down');
    expect(err.statusCode).toBe(429);
  });

  it('maps every code to a 4xx or 5xx status', () => {
    for (const status of Object.values(ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
