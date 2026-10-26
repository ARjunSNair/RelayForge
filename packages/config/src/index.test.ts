import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from './index.js';

const key = Buffer.alloc(32, 1).toString('base64');
const base = { DATABASE_URL: 'postgresql://localhost/db', SIGNING_SECRET_ENCRYPTION_KEY: key };

describe('config', () => {
  it('applies defaults', () => {
    const config = loadApiConfig(base);
    expect(config.PORT).toBe(3000);
    expect(config.QUEUE_TRANSPORT).toBe('postgres');
    expect(config.ALLOW_INSECURE_DESTINATIONS).toBe(false);
  });

  it('rejects a malformed encryption key without echoing it', () => {
    expect(() => loadApiConfig({ ...base, SIGNING_SECRET_ENCRYPTION_KEY: 'c2VjcmV0' })).toThrow(
      /SIGNING_SECRET_ENCRYPTION_KEY: must be a base64-encoded 32-byte key/,
    );
    expect(() => loadApiConfig({ ...base, SIGNING_SECRET_ENCRYPTION_KEY: 'c2VjcmV0' })).not.toThrow(
      /c2VjcmV0/,
    );
  });

  it('refuses insecure destinations in production', () => {
    expect(() =>
      loadWorkerConfig({ ...base, NODE_ENV: 'production', ALLOW_INSECURE_DESTINATIONS: 'true' }),
    ).toThrow(/cannot be enabled in production/);
  });

  it('requires Service Bus settings when that transport is selected', () => {
    expect(() => loadWorkerConfig({ ...base, QUEUE_TRANSPORT: 'servicebus' })).toThrow(
      /SERVICE_BUS_NAMESPACE/,
    );
    expect(
      loadWorkerConfig({
        ...base,
        QUEUE_TRANSPORT: 'servicebus',
        SERVICE_BUS_NAMESPACE: 'x.servicebus.windows.net',
      }).QUEUE_TRANSPORT,
    ).toBe('servicebus');
  });
});
