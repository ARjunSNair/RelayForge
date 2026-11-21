import type { Pool } from '@relayforge/database';
import { describe, expect, it } from 'vitest';
import { createQueue, PostgresQueue, ServiceBusQueue } from './index.js';

const pool = {} as Pool;

describe('createQueue', () => {
  it('builds the PostgreSQL transport by default', () => {
    const queue = createQueue({ QUEUE_TRANSPORT: 'postgres', QUEUE_NAME: 'deliveries' }, pool);
    expect(queue).toBeInstanceOf(PostgresQueue);
  });

  it('builds the Service Bus transport from a connection string', () => {
    const queue = createQueue(
      {
        QUEUE_TRANSPORT: 'servicebus',
        QUEUE_NAME: 'deliveries',
        SERVICE_BUS_CONNECTION_STRING:
          'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=c2VjcmV0',
      },
      pool,
    );
    expect(queue).toBeInstanceOf(ServiceBusQueue);
  });

  it('builds the Service Bus transport from a namespace using managed identity', () => {
    const queue = createQueue(
      {
        QUEUE_TRANSPORT: 'servicebus',
        QUEUE_NAME: 'deliveries',
        SERVICE_BUS_NAMESPACE: 'example.servicebus.windows.net',
      },
      pool,
    );
    expect(queue).toBeInstanceOf(ServiceBusQueue);
  });

  it('rejects the Service Bus transport with neither namespace nor connection string', () => {
    expect(() =>
      createQueue({ QUEUE_TRANSPORT: 'servicebus', QUEUE_NAME: 'deliveries' }, pool),
    ).toThrow(/namespace or connection string/);
  });
});
