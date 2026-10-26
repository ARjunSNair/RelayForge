import type { CommonConfig } from '@relayforge/config';
import type { Pool } from '@relayforge/database';
import { PostgresQueue } from './postgres-queue.js';
import { ServiceBusQueue } from './service-bus-queue.js';
import type { QueueReceiver, QueueSender } from './types.js';

export * from './types.js';
export * from './backoff.js';
export { PostgresQueue } from './postgres-queue.js';
export { ServiceBusQueue } from './service-bus-queue.js';

type TransportConfig = Pick<
  CommonConfig,
  'QUEUE_TRANSPORT' | 'QUEUE_NAME' | 'SERVICE_BUS_NAMESPACE' | 'SERVICE_BUS_CONNECTION_STRING'
>;

/** Build the configured transport. `lockDurationMs` applies to the Postgres transport only. */
export function createQueue(
  config: TransportConfig,
  pool: Pool,
  lockDurationMs?: number,
): QueueSender & QueueReceiver {
  if (config.QUEUE_TRANSPORT === 'servicebus') {
    return new ServiceBusQueue({
      queue: config.QUEUE_NAME,
      ...(config.SERVICE_BUS_NAMESPACE ? { namespace: config.SERVICE_BUS_NAMESPACE } : {}),
      ...(config.SERVICE_BUS_CONNECTION_STRING
        ? { connectionString: config.SERVICE_BUS_CONNECTION_STRING }
        : {}),
    });
  }
  return new PostgresQueue(pool, config.QUEUE_NAME, lockDurationMs);
}
